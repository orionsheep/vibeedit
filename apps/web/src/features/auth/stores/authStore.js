import { defineStore } from 'pinia';
import { fetchSession, loginWithPassword, logoutSession, registerWithPassword } from '../api/authApi';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    sessionChecked: false,
    bootstrapAdminEmail: '',
    loading: false,
    sessionPromise: null
  }),

  getters: {
    isAuthenticated: (state) => Boolean(state.user),
    isAdmin: (state) => String(state.user?.role || '') === 'admin'
  },

  actions: {
    async hydrateSession(force = false) {
      if (this.sessionChecked && !force) {
        return this.user;
      }
      if (this.sessionPromise && !force) {
        return this.sessionPromise;
      }

      this.loading = true;
      this.sessionPromise = fetchSession()
        .then((result) => {
          this.user = result?.authenticated ? result.user || null : null;
          this.bootstrapAdminEmail = String(result?.bootstrap_admin_email || '').trim();
          this.sessionChecked = true;
          return this.user;
        })
        .catch(() => {
          this.user = null;
          this.sessionChecked = true;
          return null;
        })
        .finally(() => {
          this.loading = false;
          this.sessionPromise = null;
        });

      return this.sessionPromise;
    },

    async login(payload = {}) {
      this.loading = true;
      try {
        const result = await loginWithPassword(payload);
        this.user = result.user || null;
        this.sessionChecked = true;
        return this.user;
      } finally {
        this.loading = false;
      }
    },

    async register(payload = {}) {
      this.loading = true;
      try {
        const result = await registerWithPassword(payload);
        this.user = result.user || null;
        this.sessionChecked = true;
        return this.user;
      } finally {
        this.loading = false;
      }
    },

    async logout() {
      this.loading = true;
      try {
        await logoutSession();
      } finally {
        this.user = null;
        this.sessionChecked = true;
        this.loading = false;
      }
    }
  }
});
