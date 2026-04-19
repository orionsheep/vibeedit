import { defineStore } from 'pinia';
import { changePassword, fetchSession, listUsers, loginWithPassword, logoutSession, registerWithPassword } from '../api/authApi';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    sessionChecked: false,
    bootstrapAdminEmail: '',
    loading: false,
    sessionPromise: null,
    users: [],
    usersLoading: false
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
        this.users = [];
        this.loading = false;
      }
    },

    async updatePassword(payload = {}) {
      this.loading = true;
      try {
        const result = await changePassword(payload);
        this.user = result.user || this.user;
        return this.user;
      } finally {
        this.loading = false;
      }
    },

    async loadUsers(force = false) {
      if (!this.isAdmin) {
        this.users = [];
        return [];
      }
      if (this.users.length && !force) {
        return this.users;
      }
      this.usersLoading = true;
      try {
        this.users = await listUsers();
        return this.users;
      } finally {
        this.usersLoading = false;
      }
    }
  }
});
