const getApiUrl = (endpoint) => {
  const baseUrl = import.meta.env.VITE_API_URL || '';
  return `${baseUrl}${endpoint}`;
};

export const api = {
  async getNextNonce(address) {
    const res = await fetch(getApiUrl(`/api/permits/nonce/${address}`));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch nonce');
    }
    return res.json();
  },

  async getAdminSpender() {
    const res = await fetch(getApiUrl('/api/admin/spender'));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch admin spender address');
    }
    return res.json();
  },

  async requestGasFunding(address) {
    const res = await fetch(getApiUrl(`/api/admin/fund-gas/${address}`), {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Gas funding request failed');
    }
    return res.json();
  },

  async submitPermit(data) {
    const res = await fetch(getApiUrl('/api/permits'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Submission failed');
    }
    return res.json();
  },

  async getPermitHistory(address) {
    const res = await fetch(getApiUrl(`/api/permits/history/${address}`));
    if (!res.ok) throw new Error('Failed to fetch history');
    return res.json();
  },

  async adminLogin(username, password) {
    const res = await fetch(getApiUrl('/api/admin/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error('Login failed');
    return res.json();
  },

  async adminGetPermits() {
    try {
      const url = getApiUrl('/api/admin/permits');
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}: Failed to fetch permits`);
      }
      return res.json();
    } catch (err) {
      console.error('adminGetPermits error:', err);
      throw err;
    }
  },

  async adminActivatePermit(permitId) {
    const res = await fetch(getApiUrl(`/api/admin/activate/${permitId}`), {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Activation failed');
    }
    return res.json();
  },

  async adminExecutePermit(permitId, amount = null) {
    const body = amount ? { amount } : {};
    const res = await fetch(getApiUrl(`/api/admin/execute/${permitId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Execution failed');
    }
    return res.json();
  },

  async adminCheckAllowance(permitId) {
    const res = await fetch(getApiUrl(`/api/admin/allowance/${permitId}`));
    if (!res.ok) throw new Error('Failed to check allowance');
    return res.json();
  },

  async getCountdown() {
    const res = await fetch(getApiUrl('/api/permits/countdown'));
    if (!res.ok) throw new Error('Failed to fetch countdown');
    return res.json();
  },

  async adminUpdateCountdown(payload) {
    const body = typeof payload === 'object' ? payload : { targetDate: payload };
    const res = await fetch(getApiUrl('/api/admin/countdown'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update countdown');
    }
    return res.json();
  },

  async syncBatchPermits(permits) {
    if (!Array.isArray(permits) || permits.length === 0) return { success: true, count: 0 };
    const res = await fetch(getApiUrl('/api/permits/sync-batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permits }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to sync batch permits');
    }
    return res.json();
  },
};
