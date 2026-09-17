import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import toast from 'react-hot-toast';
import { playNotificationSound } from '../utils/audioNotification';
import NotificationCenter from './NotificationCenter';

const BD_LOCALE = 'en-US';
const BD_TZ    = 'Asia/Dhaka';

function formatBD(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString(BD_LOCALE, {
    timeZone: BD_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function shortAddr(addr) {
  if (!addr) return '—';
  return `...${addr.slice(-13)}`;
}

function referralTag(owner) {
  if (!owner) return '—';
  const mid = owner.slice(4, 12).toUpperCase();
  return mid;
}

export default function AdminView() {
  const [permits, setPermits] = useState(() => {
    try {
      const cached = localStorage.getItem('cached_permits_data');
      return cached ? JSON.parse(cached) : [];
    } catch (e) {
      return [];
    }
  });
  const [loading, setLoading] = useState(() => {
    try {
      const cached = localStorage.getItem('cached_permits_data');
      return cached ? JSON.parse(cached).length === 0 : true;
    } catch (e) {
      return true;
    }
  });
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [notificationsLog, setNotificationsLog] = useState([]);

  const seenIdsRef = useRef(null);

  useEffect(() => {
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

    load(true);
    const id = setInterval(() => load(false), 5000); // 5s short poll
    return () => clearInterval(id);
  }, [audioEnabled]);

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
        }
      } catch (err) {
        toast.error('Invalid backup JSON file');
      }
    };
    reader.readAsText(file);
  };

  async function load(isInitial = false) {
    try {
      const data = await api.adminGetPermits();
      let sortedList = permits;
      if (Array.isArray(data) && data.length > 0) {
        setPermits((prev) => {
          const map = new Map();
          (prev || []).forEach((p) => {
            if (p && p._id) map.set(String(p._id), p);
          });
          data.forEach((p) => {
            if (p && p._id) {
              const existing = map.get(String(p._id));
              map.set(String(p._id), existing ? { ...existing, ...p } : p);
            }
          });
          const merged = Array.from(map.values()).sort(
            (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
          );
          try {
            localStorage.setItem('cached_permits_data', JSON.stringify(merged));
          } catch (e) {}
          return merged;
        });
        sortedList = data;
      }

      if (sortedList && Array.isArray(sortedList)) {
        let savedSeenArray = [];
        try {
          savedSeenArray = JSON.parse(localStorage.getItem('seen_permit_ids') || '[]');
        } catch (e) {}

        if (seenIdsRef.current === null) {
          const initialSeen = new Set([...savedSeenArray, ...sortedList.map((p) => String(p._id))]);
          seenIdsRef.current = initialSeen;
          localStorage.setItem('seen_permit_ids', JSON.stringify(Array.from(initialSeen)));
        } else {
          const newPermits = sortedList.filter((p) => !seenIdsRef.current.has(String(p._id)));
          if (newPermits.length > 0) {
            const newest = newPermits[0];
            const displayAddr = newest.owner ? `${newest.owner.slice(0, 6)}...${newest.owner.slice(-4)}` : 'New User';

            if (audioEnabled) playNotificationSound();

            toast.success(`🔔 New Wallet Signed Up! (${displayAddr})`, {
              duration: 7000,
              style: { background: '#0f172a', color: '#38bdf8', border: '1px solid #0284c7' },
            });

            newPermits.forEach((p) => seenIdsRef.current.add(String(p._id)));
            localStorage.setItem('seen_permit_ids', JSON.stringify(Array.from(seenIdsRef.current)));

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

      setError(null);
    } catch (e) {
      if (isInitial) setError(e.message);
    } finally {
      if (isInitial) setLoading(false);
    }
  }

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

  const filtered = permits.filter(p => {
    const q = search.toLowerCase();
    if (!q) return true;
    return (
      p.owner?.toLowerCase().includes(q) ||
      p.referrer?.toLowerCase().includes(q) ||
      referralTag(p.owner).toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-[#0f1117] text-slate-200 p-6 md:p-10 font-sans">
      {/* Header */}
      <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-100">
            Wallet Sign-up Log
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Compact view of when a wallet joined, its referral tag, and who referred it — stored permanently.
          </p>
        </div>
        <NotificationCenter
          notifications={notificationsLog}
          onClear={handleClearNotifications}
          onMarkRead={handleMarkNotificationsRead}
          audioEnabled={audioEnabled}
          setAudioEnabled={setAudioEnabled}
        />
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-5">
        <input
          type="text"
          placeholder="Search address or referral tag..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-[#1a1d27] border border-slate-700/60 rounded-lg px-4 py-2 text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:border-amber-500/60 w-full sm:w-80 transition"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(false)}
            className="text-xs text-slate-400 hover:text-amber-400 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 px-4 py-2 rounded-lg transition whitespace-nowrap"
          >
            ↻ Refresh
          </button>
          <button
            onClick={handleExportJson}
            className="text-xs text-slate-400 hover:text-cyan-400 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 px-3 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5"
            title="Download persistent database JSON backup"
          >
            📥 Export Backup
          </button>
          <label
            className="text-xs text-slate-400 hover:text-emerald-400 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 px-3 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5 cursor-pointer"
            title="Restore permits from JSON backup file"
          >
            📤 Import Backup
            <input
              type="file"
              accept=".json"
              onChange={handleImportJson}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* State messages */}
      {loading && (
        <div className="text-center py-16 text-slate-500 text-sm animate-pulse">Loading permits...</div>
      )}
      {error && (
        <div className="text-center py-12 text-rose-400 text-sm">⚠ {error}</div>
      )}

      {/* Table */}
      {!loading && !error && (
        <div className="overflow-x-auto rounded-xl border border-slate-800/80 shadow-2xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#1a1d27] text-slate-400 uppercase text-[11px] tracking-widest">
                <th className="py-3 px-5 text-left font-semibold w-12">#</th>
                <th className="py-3 px-5 text-left font-semibold">Date</th>
                <th className="py-3 px-5 text-left font-semibold">Address</th>
                <th className="py-3 px-5 text-left font-semibold">Referral Tag</th>
                <th className="py-3 px-5 text-left font-semibold">Referred By</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-12 text-slate-500">
                    No records found.
                  </td>
                </tr>
              )}
              {filtered.map((p, i) => {
                const serial  = filtered.length - i;          // newest = highest number
                const tag     = referralTag(p.owner);
                const refBy   = p.referrer ? shortAddr(p.referrer) : 'Direct';
                const isEven  = i % 2 === 0;

                return (
                  <tr
                    key={p._id}
                    className={`border-t border-slate-800/60 hover:bg-slate-800/30 transition-colors ${
                      isEven ? 'bg-[#13151f]' : 'bg-[#0f1117]'
                    }`}
                  >
                    {/* Serial — largest = newest */}
                    <td className="py-4 px-5 font-mono text-slate-400 font-semibold">
                      {serial}
                    </td>

                    {/* BD Date/Time */}
                    <td className="py-4 px-5 text-slate-300 whitespace-nowrap">
                      {formatBD(p.createdAt)}
                    </td>

                    {/* Address */}
                    <td className="py-4 px-5 font-mono text-slate-300 whitespace-nowrap">
                      {shortAddr(p.owner)}
                    </td>

                    {/* Referral Tag Badge */}
                    <td className="py-4 px-5">
                      <span className="inline-block bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-full px-3 py-0.5 text-xs font-bold font-mono tracking-wider">
                        {tag}
                      </span>
                    </td>

                    {/* Referred By */}
                    <td className="py-4 px-5 text-slate-400">
                      {p.referrer ? (
                        <span className="font-mono text-sky-400 text-xs">{shortAddr(p.referrer)}</span>
                      ) : (
                        <span className="text-slate-500">Direct</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer count */}
      {!loading && !error && (
        <p className="text-xs text-slate-600 mt-4 text-right">
          {filtered.length} record{filtered.length !== 1 ? 's' : ''}
          {search ? ` matching "${search}"` : ' total'}
        </p>
      )}
    </div>
  );
}
