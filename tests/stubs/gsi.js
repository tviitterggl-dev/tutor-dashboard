// Поддельный Google Identity Services: сразу «выдаёт» токен.
window.__gisRequests = [];
window.google = {
  accounts: {
    oauth2: {
      initTokenClient(cfg) {
        return {
          callback: cfg.callback,
          error_callback: cfg.error_callback,
          requestAccessToken() {
            window.__gisRequests.push(cfg.scope);
            const write = cfg.scope.includes("calendar.events");
            setTimeout(() => this.callback({ access_token: write ? "write-token" : "read-token", expires_in: 3600 }), 5);
          },
        };
      },
    },
  },
};
