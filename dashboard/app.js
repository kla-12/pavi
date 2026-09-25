document.addEventListener('DOMContentLoaded', () => {
  // Theme Management
  const themeToggle = document.getElementById('theme-toggle');
  const body = document.body;
  
  // Check for saved theme preference
  const savedTheme = localStorage.getItem('pavi-theme');
  if (savedTheme === 'light') {
    body.setAttribute('data-theme', 'light');
    body.classList.remove('dark-theme');
  }

  themeToggle.addEventListener('click', () => {
    if (body.getAttribute('data-theme') === 'light') {
      body.removeAttribute('data-theme');
      body.classList.add('dark-theme');
      localStorage.setItem('pavi-theme', 'dark');
    } else {
      body.setAttribute('data-theme', 'light');
      body.classList.remove('dark-theme');
      localStorage.setItem('pavi-theme', 'light');
    }
  });

  // Wrap global fetch to automatically include credentials for secure cookie transport
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
      init = init || {};
      init.credentials = 'include';
      return originalFetch(input, init);
  };

  // Central Dashboard Initialization orchestrator
  let dashboardInitialized = false;
  let sseInstance = null;
  let rateSummaryInterval = null;

  function initializeDashboardComponents() {
      if (dashboardInitialized) return;
      dashboardInitialized = true;
      
      console.log("[DASHBOARD] Authenticated successfully. Launching client components.");
      loadConfig();
      loadWorkspaces();
      loadLocalModels();
      loadRateSummary();
      if (rateSummaryInterval) clearInterval(rateSummaryInterval);
      rateSummaryInterval = setInterval(loadRateSummary, 30_000);
      
      initMobileConnect();
      if (sseInstance) sseInstance.disconnect();
      sseInstance = startDesktopSocket();

      // Health Panel Polling - includes GitHub rate limit
      const loadHealthStatus = async () => {
          try {
              const res = await fetch('/api/health');
              if (!res.ok) return;
              const data = await res.json();
              const components = data.components || {};
              for (const [key, info] of Object.entries(components)) {
                  const targetKey = key === 'database' ? 'db' : key;
                  const dot = document.getElementById(`dot-${targetKey}`);
                  const detail = document.getElementById(`detail-${targetKey}`);
                  if (dot) {
                      dot.className = `health-dot ${info.status}`;
                  }
                  if (detail) {
                      if (key === 'github' && info.remaining !== undefined) {
                          detail.textContent = `${info.remaining} / ${info.limit} remaining`;
                          if (info.remaining < 500) detail.style.color = '#f59e0b';
                      } else {
                          detail.textContent = info.details || info.error || info.status;
                      }
                  }
              }
          } catch (e) {
              console.warn('[HEALTH] Panel update failed:', e.message);
          }

          // Separately poll GitHub rate limit from our dedicated endpoint
          try {
              const rlRes = await fetch('/api/github-rate-limit');
              if (!rlRes.ok) return;
              const rl = await rlRes.json();
              const dot = document.getElementById('dot-github');
              const detail = document.getElementById('detail-github');
              const rateBadge = document.getElementById('github-rate-badge');

              if (rl.available) {
                  if (dot) dot.className = `health-dot ${rl.critical ? 'error' : rl.warning ? 'warning' : 'ok'}`;
                  if (detail) {
                      detail.textContent = `${rl.remaining}/${rl.limit} (${rl.percentRemaining}%)`;
                      detail.style.color = rl.critical ? '#ef4444' : rl.warning ? '#f59e0b' : '#10b981';
                      detail.title = rl.resetAt ? `Resets at ${new Date(rl.resetAt).toLocaleTimeString()}` : '';
                  }
                  if (rateBadge) {
                      const color = rl.critical ? '#ef4444' : rl.warning ? '#f59e0b' : '#10b981';
                      rateBadge.style.display = 'block';
                      rateBadge.innerHTML = `
                          <div style="display:flex;justify-content:space-between;margin-bottom:3px;font-size:0.7em">
                            <span style="color:${color}">GitHub API</span>
                            <span style="color:${color};font-weight:600">${rl.remaining} / ${rl.limit}</span>
                          </div>
                          <div style="background:rgba(255,255,255,0.1);border-radius:4px;height:5px;overflow:hidden">
                            <div style="background:${color};width:${rl.percentRemaining}%;height:100%;border-radius:4px;transition:width 0.5s"></div>
                          </div>
                          ${rl.warning ? `<div style="font-size:0.65em;color:${color};margin-top:3px">${rl.critical ? '⛔ Critical' : '⚠️ Low'} — resets ${rl.resetAt ? new Date(rl.resetAt).toLocaleTimeString() : 'soon'}</div>` : ''}
                      `;
                  }
              } else {
                  if (rateBadge) rateBadge.style.display = 'none';
              }
          } catch (e) { /* non-critical */ }
      };

      // Load health immediately and poll every 30 seconds
      loadHealthStatus();
      setInterval(loadHealthStatus, 30_000);

      document.getElementById('refresh-health-btn')?.addEventListener('click', loadHealthStatus);

      // Write Audit initialization
      loadPendingChanges();
      document.getElementById('btn-approve-write')?.addEventListener('click', () => respondToPendingChange('approve'));
      document.getElementById('btn-reject-write')?.addEventListener('click', () => respondToPendingChange('reject'));
      document.getElementById('btn-approve-all')?.addEventListener('click', () => respondToAllPendingChanges('approve'));
      document.getElementById('btn-reject-all')?.addEventListener('click', () => respondToAllPendingChanges('reject'));

      // Swarm History initialization
      loadSwarmHistory();
      loadQualityStats();
      document.getElementById('btn-refresh-history')?.addEventListener('click', () => {
          loadSwarmHistory();
          loadQualityStats();
      });

      // Cache Stats initialization
      loadCacheStats();
      document.getElementById('refresh-cache-stats-btn')?.addEventListener('click', loadCacheStats);
      document.getElementById('clear-cache-btn')?.addEventListener('click', clearCache);
      document.getElementById('export-dpo-btn')?.addEventListener('click', exportDPODataset);

      // Plugins initialization
      loadPluginsList();
      document.getElementById('refresh-plugins-btn')?.addEventListener('click', loadPluginsList);
  };

  // Premium Connection Offline Overlay
  function showOfflineOverlay() {
      let offlineOverlay = document.getElementById('offline-overlay');
      if (!offlineOverlay) {
          offlineOverlay = document.createElement('div');
          offlineOverlay.id = 'offline-overlay';
          offlineOverlay.style.cssText = 'position:fixed; inset:0; background:rgba(10, 10, 18, 0.85); backdrop-filter: blur(25px); z-index: 100000; display:flex; align-items:center; justify-content:center;';
          offlineOverlay.innerHTML = `
            <div class="glass-card" style="width: 90%; max-width: 460px; padding: 3rem 2.5rem; border: 1px solid rgba(239, 68, 68, 0.15); border-radius: 20px; background: rgba(239, 68, 68, 0.02); box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6); text-align: center;">
              <div style="margin: 0 auto 1.5rem; width: 64px; height: 64px; border-radius: 50%; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); display: flex; align-items: center; justify-content: center; font-size: 2rem; color: #f87171; box-shadow: 0 0 20px rgba(239, 68, 68, 0.2);">⚠️</div>
              <h2 style="margin: 0 0 0.75rem; font-family: 'Outfit', sans-serif; font-weight: 700; font-size: 1.8rem; color: #f87171;">Cannot Connect to Pavi</h2>
              <p style="margin: 0 0 2rem; color: var(--text-secondary); font-size: 0.95rem; line-height: 1.6;">The dashboard is unable to reach the Pavi backend server. Please verify that the Express app is running on port 3000.</p>
              <button id="retry-connection-btn" class="btn" style="width: 100%; padding: 0.85rem; border-radius: 8px; font-weight: bold; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; font-size: 1rem; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='rgba(239, 68, 68, 0.25)'" onmouseout="this.style.background='rgba(239, 68, 68, 0.15)'">🔄 Retry Connection</button>
            </div>
          `;
          document.body.appendChild(offlineOverlay);
          
          document.getElementById('retry-connection-btn').addEventListener('click', () => {
              offlineOverlay.style.opacity = '0.5';
              setTimeout(async () => {
                  try {
                      const res = await fetch('/api/auth/status');
                      if (res.ok || res.status === 401) {
                          offlineOverlay.remove();
                          checkSessionStatus();
                      } else {
                          offlineOverlay.style.opacity = '1';
                      }
                  } catch (e) {
                      offlineOverlay.style.opacity = '1';
                  }
              }, 600);
          });
      }
  }

  // Verify Auth Session status (Auth disabled - always active)
  async function checkSessionStatus() {
      const loginOverlay = document.getElementById('login-overlay');
      if (loginOverlay) loginOverlay.style.display = 'none';
      initializeDashboardComponents();
  }

  // Hook Login and registration form submission
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const usernameInput = document.getElementById('login-username');
          const passwordInput = document.getElementById('login-password');
          const errorMsg = document.getElementById('login-error');
          const loginOverlay = document.getElementById('login-overlay');
          const isSetupMode = loginOverlay.dataset.setupMode === 'true';
          
          if (!usernameInput || !passwordInput) return;
          
          const username = usernameInput.value.trim();
          const password = passwordInput.value;
          
          if (errorMsg) errorMsg.style.display = 'none';
          
          try {
              if (isSetupMode) {
                  // Setup initial admin account first
                  const regRes = await fetch('/api/auth/register', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ username, password })
                  });
                  const regData = await regRes.json();
                  if (!regRes.ok) {
                      throw new Error(regData.error || 'Failed to register administrative account.');
                  }
              }
              
              // Proceed with authentication login check
              const loginRes = await fetch('/api/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ username, password })
              });
              const loginData = await loginRes.json();
              
              if (loginRes.ok && loginData.success) {
                  // Successful login!
                  usernameInput.value = '';
                  passwordInput.value = '';
                  checkSessionStatus();
              } else {
                  throw new Error(loginData.error || 'Invalid credentials.');
              }
          } catch (err) {
              if (errorMsg) {
                  errorMsg.textContent = err.message;
                  errorMsg.style.display = 'block';
              }
          }
      });
  }

  // Hook Sidebar Logout click handler
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
          try {
              const res = await fetch('/api/auth/logout', {
                  method: 'POST'
              });
              if (res.ok) {
                  // Reload or force re-check status to show login
                  window.location.reload();
              }
          } catch (err) {
              console.error("Logout request failed", err);
          }
      });
  }

  // Load saved Orchestrator Config from Backend
  async function loadConfig() {
      try {
          const res = await fetch('/api/config');
          if (res.ok) {
              const data = await res.json();
              if (data && data.workerUrl) {
                  window.orchestratorConfig = data;
                  const workerProvider = document.getElementById('worker-provider');
                  const workerKey = document.getElementById('worker-key');
                  const reviewerProvider = document.getElementById('reviewer-provider');
                  const reviewerKey = document.getElementById('reviewer-key');
                  
                  if (workerProvider && window.orchestratorConfig.workerUrl) {
                      const val = `${window.orchestratorConfig.workerUrl}|${window.orchestratorConfig.workerModel}`;
                      let exists = false;
                      for (let i = 0; i < workerProvider.options.length; i++) {
                          if (workerProvider.options[i].value === val) {
                              exists = true;
                              break;
                          }
                      }
                      if (!exists) {
                          const opt = document.createElement('option');
                          opt.value = val;
                          opt.textContent = `${window.orchestratorConfig.workerModel} (Custom - ${window.orchestratorConfig.workerUrl})`;
                          workerProvider.appendChild(opt);
                      }
                      workerProvider.value = val;
                  }
                  if (workerKey && window.orchestratorConfig.workerKeys) {
                      workerKey.value = window.orchestratorConfig.workerKeys.join('\n');
                  }
                  if (reviewerProvider && window.orchestratorConfig.reviewerUrl) {
                      const val = `${window.orchestratorConfig.reviewerUrl}|${window.orchestratorConfig.reviewerModel}`;
                      let exists = false;
                      for (let i = 0; i < reviewerProvider.options.length; i++) {
                          if (reviewerProvider.options[i].value === val) {
                              exists = true;
                              break;
                          }
                      }
                      if (!exists) {
                          const opt = document.createElement('option');
                          opt.value = val;
                          opt.textContent = `${window.orchestratorConfig.reviewerModel} (Custom - ${window.orchestratorConfig.reviewerUrl})`;
                          reviewerProvider.appendChild(opt);
                      }
                      reviewerProvider.value = val;
                  }
                  if (reviewerKey && window.orchestratorConfig.reviewerKeys) {
                      reviewerKey.value = window.orchestratorConfig.reviewerKeys.join('\n');
                  }
              }
          }
      } catch (e) {
          console.error("Failed to fetch backend config", e);
      }
  }
  // loadConfig is initialized by checkSessionStatus

  // Load local Ollama models
  async function loadLocalModels() {
      const select = document.getElementById('local-model-select');
      try {
          const res = await fetch('/api/models');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!select) return;
          
          const models = data.models || [];
          if (models.length === 0) {
              select.innerHTML = '<option value="phi3:mini">phi3:mini (Default)</option>';
              select.value = 'phi3:mini';
              return;
          }

          select.innerHTML = models.map(m => {
              const name = typeof m === 'string' ? m : (m.name || '');
              return `<option value="${name}">${name}</option>`;
          }).join('');
          
          const activeModel = data.selected_model || data.activeModel || (models[0] && typeof models[0] === 'string' ? models[0] : models[0]?.name);
          if (activeModel) {
              select.value = activeModel;
          }
      } catch (e) {
          console.warn('[MODELS] Failed to load local models:', e.message);
          if (select) {
              select.innerHTML = '<option value="phi3:mini">phi3:mini (Default)</option>';
              select.value = 'phi3:mini';
          }
      }
  }

  const modelSelectElement = document.getElementById('local-model-select');
  if (modelSelectElement) {
      modelSelectElement.addEventListener('change', async (e) => {
          const model = e.target.value;
          try {
              await fetch('/api/models/select', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model })
              });
          } catch (err) {
              console.error("Failed to save model selection", err);
          }
      });
  }

  // ── Pavi Evolution: Rate Summary Widget ─────────────────────────────────────
  // Polls /api/rate-summary every 30s and renders a live key-health panel
  async function loadRateSummary() {
      try {
          const res = await fetch('/api/rate-summary');
          if (!res.ok) return;
          const data = await res.json();
          const widget = document.getElementById('rate-status-widget');
          if (!widget) return;

          // Build compact HTML for each key pool
          const renderPool = (pool, label) => {
              if (!pool || pool.length === 0) return '';
              const items = pool.map(k => {
                  const pct = Math.max(0, Math.min(100, Math.round((k.tokens / (k.capacity || 10)) * 100)));
                  const color = pct > 60 ? '#10b981' : pct > 30 ? '#f59e0b' : '#ef4444';
                  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                      <span style="font-size:0.75em;color:#94a3b8;font-family:monospace">…${k.keyPreview || '????'}</span>
                      <span style="font-size:0.75em;padding:2px 8px;border-radius:10px;background:${color}22;color:${color}">${pct}% tokens</span>
                  </div>`;
              }).join('');
              return `<div style="margin-bottom:0.75rem"><div style="font-size:0.7em;text-transform:uppercase;letter-spacing:1px;color:#6366f1;margin-bottom:4px">${label}</div>${items}</div>`;
          };

          const callLog = data.callLog || [];
          const lastCall = callLog[callLog.length - 1];
          const lastCallStr = lastCall ? new Date(lastCall.ts || Date.now()).toLocaleTimeString() : 'None yet';

          widget.innerHTML = `
              <div style="font-size:0.8em;color:#a78bfa;font-weight:600;margin-bottom:8px">🔑 API Key Health</div>
              ${renderPool(data.workerPool, 'Worker Keys')}
              ${renderPool(data.reviewerPool, 'Reviewer Keys')}
              <div style="font-size:0.72em;color:#64748b;margin-top:4px">Last API call: ${lastCallStr} | Total: ${callLog.length}</div>
          `;
      } catch (e) {}
  };
  // loadRateSummary is initialized by checkSessionStatus

  // ── Generate QR code pointing to /mobile (with ngrok upgrade support) ──────
  const renderQR = (mobileUrl, isNgrok) => {
      const qrContainer = document.getElementById('qrcode-container');
      const linkInput = document.getElementById('mobile-access-link');
      if (linkInput) linkInput.value = mobileUrl;

      if (!qrContainer) return;
      const encoded = encodeURIComponent(mobileUrl);
      const badgeHtml = isNgrok
          ? `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(16,185,129,0.15);border:1px solid #10b981;border-radius:20px;padding:4px 12px;font-size:0.75em;color:#10b981;font-weight:600">🌐 ngrok Active — works from anywhere</div>`
          : `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.4);border-radius:20px;padding:4px 12px;font-size:0.75em;color:#a5b4fc">📡 LAN only — same WiFi required</div>`;
      const upgradeHtml = isNgrok
          ? `<button onclick="window._checkNgrok()" style="margin-top:4px;background:rgba(16,185,129,0.15);border:1px solid #10b98166;color:#10b981;border-radius:8px;padding:4px 14px;font-size:0.75em;cursor:pointer">♻ Refresh ngrok URL</button>`
          : `<button onclick="window._checkNgrok()" style="margin-top:4px;background:rgba(99,102,241,0.15);border:1px solid #6366f166;color:#a5b4fc;border-radius:8px;padding:4px 14px;font-size:0.75em;cursor:pointer">🌐 Upgrade to ngrok</button>`;

      qrContainer.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
              ${badgeHtml}
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encoded}"
                   alt="QR Code" width="180" height="180" style="border-radius:8px;box-shadow:0 0 0 4px ${isNgrok ? '#10b98133' : '#6366f133'}"
                   onerror="this.parentElement.innerHTML='<div style=\\'color:#ef4444;font-size:0.8em\\'>QR unavailable offline.<br>Use the link below.</div>'">
              <div style="font-size:0.8em;color:#6366f1;text-align:center">Scan to open <strong>Pavi Mobile</strong></div>
              <div style="font-size:0.72em;color:#64748b;font-family:monospace;word-break:break-all;text-align:center;max-width:200px">${mobileUrl}</div>
              ${upgradeHtml}
          </div>`;

      // Update copy button target
      const copyMobileBtn = document.getElementById('copy-mobile-link-btn');
      if (copyMobileBtn) {
          copyMobileBtn.onclick = () => {
              navigator.clipboard.writeText(mobileUrl).then(() => {
                  copyMobileBtn.textContent = '✅ Copied!';
                  setTimeout(() => { copyMobileBtn.textContent = '📋 Copy'; }, 2000);
              });
          };
      }
  };

  // Check ngrok, then fall back to LAN
  window._checkNgrok = async () => {
      const qrContainer = document.getElementById('qrcode-container');
      if (qrContainer) qrContainer.innerHTML = `
          <div style="color:#64748b;font-size:0.82em;text-align:center;padding:2rem;display:flex;flex-direction:column;align-items:center;gap:12px">
              <div class="loading-spinner-small"></div>
              <div>🔍 Checking for ngrok tunnel...</div>
          </div>`;
      
      try {
          const ngrokRes = await fetch('/api/ngrok-url');
          const ngrokData = await ngrokRes.json();
          
          if (ngrokData.ngrokUrl && ngrokData.mobileUrl) {
              renderQR(ngrokData.mobileUrl, true);
          } else {
              // Fall back to LAN with a hint about why ngrok failed
              console.log('[MOBILE] ngrok not found:', ngrokData.reason);
              const ipRes = await fetch('/api/local-ip');
              const { mobileUrl } = await ipRes.json();
              renderQR(mobileUrl, false);
              
              if (qrContainer && ngrokData.reason) {
                  const hint = document.createElement('div');
                  hint.className = 'mobile-hint';
                  hint.textContent = `Note: ${ngrokData.reason === 'ngrok not detected' ? 'Start ngrok to enable public access.' : 'ngrok error: ' + ngrokData.reason}`;
                  qrContainer.querySelector('div').appendChild(hint);
              }
          }
      } catch(e) {
          console.warn('[MOBILE] ngrok check failed:', e.message);
          const ipRes = await fetch('/api/local-ip').catch(() => null);
          if (ipRes) {
              const { mobileUrl } = await ipRes.json();
              renderQR(mobileUrl, false);
          }
      }
  };

  async function initMobileConnect() {
      try {
          // Show loading state while resolving URL
          const qrContainer = document.getElementById('qrcode-container');
          const linkInput = document.getElementById('mobile-access-link');
          if (qrContainer) qrContainer.innerHTML = '<div style="color:#a5b4fc;font-size:0.82em;text-align:center;padding:2rem;display:flex;flex-direction:column;align-items:center;gap:8px"><div style="font-size:1.5em">🌐</div><div>Checking for ngrok tunnel...</div></div>';
          if (linkInput) linkInput.value = 'Checking ngrok...';

          // 1. Try ngrok FIRST — it is the preferred public URL
          let usedNgrok = false;
          try {
              const ngrokRes = await fetch('/api/ngrok-url');
              const ngrokData = await ngrokRes.json();
              if (ngrokData.ngrokUrl && ngrokData.mobileUrl) {
                  renderQR(ngrokData.mobileUrl, true);
                  usedNgrok = true;
              }
          } catch(_) { /* ngrok not running */ }

          // 2. Fall back to LAN IP only if ngrok isn't available
          if (!usedNgrok) {
              const ipRes = await fetch('/api/local-ip');
              if (!ipRes.ok) return;
              const { mobileUrl: lanUrl } = await ipRes.json();
              renderQR(lanUrl, false);
          }

          // Phone-connected indicator in mobile panel
          const mobilePanel = document.getElementById('mobile-panel');
          if (mobilePanel) {
              const existingBadge = document.getElementById('phone-conn-badge');
              if (!existingBadge) {
                  const badge = document.createElement('div');
                  badge.id = 'phone-conn-badge';
                  badge.style.cssText = 'margin-top:1rem;text-align:center;font-size:0.82em;color:#64748b;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.08)';
                  badge.textContent = '📱 0 phones connected';
                  const card = mobilePanel.querySelector('.card');
                  if (card) card.appendChild(badge);
              }
          }
      } catch(e) {
          console.warn('[MOBILE] Could not init mobile connect:', e.message);
      }
  };
  // initMobileConnect is initialized by checkSessionStatus

  // ── Folder select → broadcast to phone via /api/session ─────────
  const magicDirInput = document.getElementById('magic-target-dir');
  if (magicDirInput) {
      const broadcastFolder = () => {
          const folder = magicDirInput.value.trim();
          if (!folder) return;
          fetch('/api/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ selectedFolder: folder })
          }).catch(() => {});
      };
      magicDirInput.addEventListener('change', broadcastFolder);
      magicDirInput.addEventListener('blur', broadcastFolder);
  }

  // Helper to toggle between Build and Cancel states
  function setBuildRunningState(running) {
      const buildBtn = document.getElementById('unified-build-btn');
      const cancelBtn = document.getElementById('unified-cancel-btn');
      const spinner = document.getElementById('magic-loading-spinner');
      if (running) {
          if (spinner) spinner.style.display = 'inline';
          if (buildBtn) {
              buildBtn.disabled = true;
              buildBtn.style.display = 'none';
          }
          if (cancelBtn) cancelBtn.style.display = 'inline-block';
      } else {
          if (spinner) spinner.style.display = 'none';
          if (buildBtn) {
              buildBtn.disabled = false;
              buildBtn.style.display = 'inline-block';
          }
          if (cancelBtn) cancelBtn.style.display = 'none';
      }
  }

  // ── WebSocket: subscribe for incoming events ───
  function startDesktopSocket() {
      let socket = null;
      if (typeof io !== 'undefined') {
          socket = io(); // Connect to same origin
          socket.on('context_note', (data) => {
              try {
                  const prompt = document.getElementById('unified-prompt');
                  if (prompt && data?.note) {
                      const prefix = prompt.value.trim() ? '\n\n[From Phone]: ' : '[From Phone]: ';
                      prompt.value += prefix + data.note;
                      // Flash indicator
                      const badge = document.getElementById('phone-conn-badge');
                      if (badge) { badge.textContent = '📱 Context note received from phone ✅'; badge.style.color = '#10b981'; }
                      setTimeout(() => {
                          if (badge) { badge.textContent = `📱 phone connected`; badge.style.color = '#64748b'; }
                      }, 3000);
                  }
                  document.dispatchEvent(new CustomEvent('pavi-sse', { detail: { type: 'context_note', data } }));
              } catch(_) {}
          });

          socket.on('session', (data) => {
              const badge = document.getElementById('phone-conn-badge');
              if (badge && data?.phoneCount !== undefined) {
                  badge.textContent = `📱 ${data.phoneCount} phone${data.phoneCount !== 1 ? 's' : ''} connected`;
                  badge.style.color = data.phoneCount > 0 ? '#10b981' : '#64748b';
              }
              document.dispatchEvent(new CustomEvent('pavi-sse', { detail: { type: 'session', data } }));
          });

          // Catch-all for other events to maintain compatibility
          socket.onAny((eventName, ...args) => {
              if (eventName !== 'context_note' && eventName !== 'session') {
                  const data = args[0] || {};
                  document.dispatchEvent(new CustomEvent('pavi-sse', { detail: { type: eventName, data } }));
              }
          });
          
          window.paviSocket = socket;
      }
      return { disconnect: () => socket && socket.disconnect() };
  }

  // Hook up cancel button handler
  const cancelBtnEl = document.getElementById('unified-cancel-btn');
  if (cancelBtnEl) {
      cancelBtnEl.addEventListener('click', () => {
          if (window.paviSocket) {
              window.paviSocket.emit('cancel_swarm');
              addTimelineItem("Cancelling...", "Sending cancel command to agentic swarm...", "🛑");
          }
      });
  }

  // ── Broadcast task status when Magic executes ────────────────────
  // (Hooks into the existing unified-build-btn — non-destructive)
  const magicExecuteBtn = document.getElementById('unified-build-btn');
  if (magicExecuteBtn) {
      const origClick = magicExecuteBtn.onclick;
      magicExecuteBtn.addEventListener('click', () => {
          const folder = document.getElementById('magic-target-dir')?.value?.trim() || '';
          const task = document.getElementById('unified-prompt')?.value?.trim()?.slice(0, 120) || '';
          fetch('/api/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'running', currentTask: task, selectedFolder: folder })
          }).catch(() => {});
      }, true); // capture phase so it fires before existing handlers
  }

  // Navigation Logic
  const navLinks = document.querySelectorAll('.sidebar-nav a');
  const panels = document.querySelectorAll('.panel');
  const sidebar = document.querySelector('.sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const mobileMenuToggle = document.getElementById('mobile-menu-toggle');

  // Mobile menu open / close toggle
  if (mobileMenuToggle && sidebar) {
    mobileMenuToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      if (sidebarBackdrop) sidebarBackdrop.classList.toggle('active');
    });
  }

  // Close mobile drawer when clicking backdrop
  if (sidebarBackdrop && sidebar) {
    sidebarBackdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      sidebarBackdrop.classList.remove('active');
    });
  }

  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      
      // Update active nav link
      document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
      link.parentElement.classList.add('active');

      // Update active panel
      const targetId = link.getAttribute('data-target');
      panels.forEach(panel => {
        if (panel.id === targetId) {
          panel.classList.add('active');
        } else {
          panel.classList.remove('active');
        }
      });

      // Auto-close mobile drawer after navigating
      if (sidebar && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');
      }
    });
  });

  // Command Execution Logic
  const executeBtns = document.querySelectorAll('.execute-cmd-btn');
  const cliOutput = document.getElementById('cli-output');
  const copyBtn = document.getElementById('copy-btn');
  const loadingSpinner = document.getElementById('loading-spinner');
  let currentOutput = '';

  executeBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.getAttribute('data-type');
      let command = '';

      switch (type) {
        case 'swarm-init':
          const topology = document.getElementById('topology').value;
          const maxAgents = document.getElementById('max-agents').value;
          command = `npx claude-flow swarm init --topology ${topology} --max-agents ${maxAgents}`;
          break;
        
        case 'swarm-start':
          const objective = document.getElementById('objective').value || 'New Task';
          const strategy = document.getElementById('strategy').value;
          command = `npx claude-flow swarm start --objective "${objective}" --strategy ${strategy}`;
          break;
        
        case 'agent-spawn':
          const agentType = document.getElementById('agent-type').value;
          const agentName = document.getElementById('agent-name').value || `worker-${Math.floor(Math.random() * 1000)}`;
          command = `npx claude-flow agent spawn --type ${agentType} --name ${agentName}`;
          break;
        
        case 'memory-search':
          const query = document.getElementById('search-query').value || 'patterns';
          const searchNs = document.getElementById('search-namespace').value;
          command = `npx claude-flow memory search --query "${query}" --namespace ${searchNs}`;
          break;
        
        case 'memory-store':
          const key = document.getElementById('store-key').value || 'my-key';
          const value = document.getElementById('store-value').value || 'my-value';
          const storeNs = document.getElementById('store-namespace').value;
          command = `npx claude-flow memory store --key "${key}" --value "${value}" --namespace ${storeNs}`;
          break;
      }

      // Prepare UI for execution
      cliOutput.textContent = `> ${command}\n\nExecuting...`;
      copyBtn.disabled = true;
      loadingSpinner.style.display = 'inline';
      
      const cwd = document.getElementById('target-dir').value.trim();
      
      try {
        const response = await fetch('/api/execute', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ command, cwd: cwd || undefined })
        });
        
        const data = await response.json();
        
        let outputText = `> ${command}\n\n`;
        if (data.stdout) outputText += `${data.stdout}\n`;
        if (data.stderr) outputText += `\n[STDERR]:\n${data.stderr}`;
        if (data.error) outputText += `\n[ERROR]:\n${data.error}`;
        
        currentOutput = outputText;
        cliOutput.textContent = outputText;
        copyBtn.disabled = false;
      } catch (err) {
        currentOutput = `> ${command}\n\n[FETCH ERROR]: Could not connect to the backend server. Make sure you are running 'node server.js'.\n${err.message}`;
        cliOutput.textContent = currentOutput;
        copyBtn.disabled = false;
      } finally {
        loadingSpinner.style.display = 'none';
      }
    });
  });

  // Copy to Clipboard Logic
  const toast = document.getElementById('copy-toast');
  
  function showToast() {
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    
    // Avoid scrolling to bottom
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const successful = document.execCommand('copy');
      if (successful) {
        showToast();
      } else {
        console.error('Fallback: Copying text command was unsuccessful');
      }
    } catch (err) {
      console.error('Fallback: Oops, unable to copy', err);
    }

    document.body.removeChild(textArea);
  }

  copyBtn.addEventListener('click', () => {
    if (!currentOutput) return;
    
    if (!navigator.clipboard) {
      fallbackCopyTextToClipboard(currentOutput);
      return;
    }
    
    navigator.clipboard.writeText(currentOutput).then(() => {
      showToast();
    }).catch(err => {
      console.error('Failed to copy output: ', err);
      // Fallback in case writeText fails due to permissions on file://
      fallbackCopyTextToClipboard(currentOutput);
    });
  });

  // --- Advanced Mode Toggle ---
  const advancedToggle = document.getElementById('advanced-mode-toggle');
  const magicNav = document.getElementById('magic-nav');
  const advancedNav = document.getElementById('advanced-nav');
  
  if (advancedToggle) {
    advancedToggle.addEventListener('change', (e) => {
      if (e.target.checked) {
        magicNav.style.display = 'none';
        advancedNav.style.display = 'flex';
        panels.forEach(p => p.classList.remove('active'));
        document.getElementById('swarm-panel').classList.add('active');
        document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
        document.querySelector('[data-target="swarm-panel"]').parentElement.classList.add('active');
      } else {
        magicNav.style.display = 'flex';
        advancedNav.style.display = 'none';
        panels.forEach(p => p.classList.remove('active'));
        document.getElementById('magic-panel').classList.add('active');
        document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
        document.querySelector('[data-target="magic-panel"]').parentElement.classList.add('active');
      }
    });
  }

  // --- Unified Timeline/Chat Output Logic ---
  function addTimelineItem(title, desc, icon="✅") {
    const timeline = document.getElementById('unified-chat-history');
    const item = document.createElement('div');
    
    // Choose status class and colors based on icon and title
    let typeClass = 'status-success';
    const lowerTitle = (title || '').toLowerCase();
    const iconStr = String(icon || '');
    if (iconStr.includes('❌') || iconStr.includes('🛑') || lowerTitle.includes('failed') || lowerTitle.includes('issue') || lowerTitle.includes('error') || lowerTitle.includes('aborted')) {
      typeClass = 'status-error';
    } else if (iconStr.includes('⚠️') || iconStr.includes('⚡') || iconStr.includes('🔄') || lowerTitle.includes('warning') || lowerTitle.includes('escalation')) {
      typeClass = 'status-warning';
    } else if (iconStr.includes('🤔') || iconStr.includes('📝') || iconStr.includes('⚙️') || iconStr.includes('🚀') || lowerTitle.includes('thinking') || lowerTitle.includes('drafting') || lowerTitle.includes('autonomous')) {
      typeClass = 'status-info';
    }

    item.className = `timeline-item-card ${typeClass}`;
    item.innerHTML = `
      <div class="timeline-item-icon">${icon}</div>
      <div class="timeline-item-body">
        <div class="timeline-item-title">${title}</div>
        <div class="timeline-item-desc">${desc}</div>
      </div>
    `;
    if (timeline) {
      timeline.appendChild(item);
      timeline.scrollTop = timeline.scrollHeight;
    }
  }

  // ── Pavi Evolution: Live Mermaid Graph Renderer ──────────────────────────
  async function renderMermaid(diagramCode) {
    const container = document.getElementById('mermaid-container');
    const output = document.getElementById('mermaid-output');
    const skeleton = document.getElementById('mermaid-skeleton');
    if (!container || !output) return;

    container.style.display = 'block';
    if (skeleton) skeleton.textContent = 'Rendering...';

    try {
      const id = 'mermaid-graph-' + Date.now();
      const { svg } = await mermaid.render(id, diagramCode);
      output.innerHTML = svg;
      if (skeleton) skeleton.style.display = 'none';
    } catch (e) {
      output.innerHTML = `<code style="color:#f87171;font-size:0.8em;">[Graph render error: ${e.message}]</code>`;
      if (skeleton) skeleton.style.display = 'none';
    }
  }

  function showShieldBadge(confidence) {
    const badge = document.getElementById('shield-badge');
    if (badge) {
      badge.style.display = 'inline-block';
      badge.textContent = `🛡️ Shield ${Math.round(confidence * 100)}%`;
      badge.title = `Neutrality confidence: ${confidence}`;
    }
  }

  // Intercept orchestrate stream for embedded Mermaid chunks
  // Format expected: [MERMAID_GRAPH]...flowchart TD...[/MERMAID_GRAPH]
  function processMagicStreamChunk(chunk) {
    const mermaidMatch = chunk.match(/\[MERMAID_GRAPH\]([\s\S]*?)\[\/MERMAID_GRAPH\]/);
    if (mermaidMatch) {
      renderMermaid(mermaidMatch[1].trim());
      return chunk.replace(/\[MERMAID_GRAPH\][\s\S]*?\[\/MERMAID_GRAPH\]/, '[graph rendered]');
    }
    const shieldMatch = chunk.match(/\[SHIELD_CONFIDENCE:([\d.]+)\]/);
    if (shieldMatch) {
      showShieldBadge(parseFloat(shieldMatch[1]));
      return chunk.replace(/\[SHIELD_CONFIDENCE:[\d.]+\]/, '');
    }
    return chunk;
  }

  // --- Folder Picker Logic ---
  const browseBtn = document.getElementById('browse-folder-btn');
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      browseBtn.disabled = true;
      const originalText = browseBtn.textContent;
      browseBtn.textContent = 'Opening...';
      try {
        const res = await fetch('/api/select-folder');
        const data = await res.json();
        if (data.path) {
          document.getElementById('target-dir').value = data.path; // Update top input too
          document.getElementById('magic-target-dir').value = data.path;
        }
      } catch (err) {
        console.error("Failed to open folder picker", err);
      } finally {
        browseBtn.disabled = false;
        browseBtn.textContent = originalText;
      }
    });
  }

  const browseZipBtn = document.getElementById('browse-zip-btn');
  if (browseZipBtn) {
    browseZipBtn.addEventListener('click', async () => {
      browseZipBtn.disabled = true;
      const originalText = browseZipBtn.textContent;
      browseZipBtn.textContent = 'Opening...';
      try {
        const res = await fetch('/api/select-zip');
        const data = await res.json();
        if (data.path) {
          document.getElementById('zip-file-path').value = data.path;
        }
      } catch (err) {
        console.error("Failed to open file picker", err);
      } finally {
        browseZipBtn.disabled = false;
        browseZipBtn.textContent = originalText;
      }
    });
  }

  // --- Zip Drag & Drop Logic ---
  const zipDropZone = document.getElementById('zip-drop-zone');
  const zipFileInput = document.getElementById('zip-file-input');
  
  if (zipDropZone && zipFileInput) {
    zipDropZone.addEventListener('click', () => zipFileInput.click());
    
    zipDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zipDropZone.style.borderColor = 'var(--accent-primary)';
      zipDropZone.style.background = 'rgba(99, 102, 241, 0.1)';
    });
    
    zipDropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      zipDropZone.style.borderColor = 'var(--glass-border)';
      zipDropZone.style.background = 'rgba(0, 0, 0, 0.2)';
    });
    
    zipDropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zipDropZone.style.borderColor = 'var(--glass-border)';
      zipDropZone.style.background = 'rgba(0, 0, 0, 0.2)';
      
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await handleZipUpload(e.dataTransfer.files[0]);
      }
    });
    
    zipFileInput.addEventListener('change', async (e) => {
      if (e.target.files && e.target.files.length > 0) {
        await handleZipUpload(e.target.files[0]);
      }
    });
  }

  async function handleZipUpload(file) {
    if (!file.name.endsWith('.zip')) {
      alert("Please upload a valid .zip file");
      return;
    }
    
    document.getElementById('zip-file-path').value = 'Uploading...';
    
    try {
      const buffer = await file.arrayBuffer();
      const response = await fetch('/api/upload-zip?filename=' + encodeURIComponent(file.name), {
        method: 'POST',
        body: buffer,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
      const data = await response.json();
      if (data.path) {
        document.getElementById('zip-file-path').value = data.path;
      } else {
        alert("Upload failed: " + data.error);
        document.getElementById('zip-file-path').value = '';
      }
    } catch (err) {
      console.error(err);
      alert("Failed to upload zip file");
      document.getElementById('zip-file-path').value = '';
    }
  }

  // --- Clarify Prompt Logic ---
  const clarifyBtn = document.getElementById('clarify-prompt-btn');
  const magicPromptArea = document.getElementById('unified-prompt');
  
  if (clarifyBtn && magicPromptArea) {
      clarifyBtn.addEventListener('click', async () => {
          const prompt = magicPromptArea.value.trim();
          if (!prompt) {
              alert("Please enter an idea first to clarify it.");
              return;
          }
          if (!window.orchestratorConfig) {
              alert("Please configure the 'Maker & Checker Engine' in Advanced Mode first. The AI needs API access to clarify your prompt!");
              return;
          }

          clarifyBtn.disabled = true;
          const originalText = clarifyBtn.innerHTML;
          clarifyBtn.innerHTML = '⏳ Clarifying...';

          try {
              const res = await fetch('/api/clarify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      prompt: prompt,
                      apiUrl: window.orchestratorConfig.workerUrl,
                      apiKey: window.orchestratorConfig.workerKey
                  })
              });
              
              const data = await res.json();
              if (data.clarified) {
                  magicPromptArea.value = data.clarified;
              } else if (data.error) {
                  alert("Failed to clarify: " + data.error);
              }
          } catch (err) {
              console.error(err);
              alert("Failed to reach clarification server. Is the backend running?");
          } finally {
              clarifyBtn.disabled = false;
              clarifyBtn.innerHTML = originalText;
          }
      });
  }

  // Pick Files button for file targeting
  const pickFilesBtn = document.getElementById('pick-files-btn');
  if (pickFilesBtn) {
    let selectedTargetFiles = [];
    pickFilesBtn.addEventListener('click', async () => {
      const cwd = document.getElementById('magic-target-dir').value.trim();
      const dir = cwd || undefined;
      const url = dir ? `/api/list-files?dir=${encodeURIComponent(dir)}` : `/api/list-files`;
      try {
        const res = await fetch(url);
        const files = await res.json();
        if (!Array.isArray(files) || files.length === 0) { alert('No files found. Set a folder path first.'); return; }
        
        // Build a quick modal for file picking
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `<div style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.15);border-radius:16px;padding:2rem;max-width:600px;width:90%;max-height:70vh;display:flex;flex-direction:column;gap:1rem;">
          <h3 style="color:white;margin:0;">🎯 Pick Files to Target</h3>
          <p style="color:#aaa;margin:0;font-size:0.9em;">Select the files you want Pavi to focus on and improve.</p>
          <div id="file-pick-list" style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:0.4rem;">${files.map(f => `<label style="display:flex;align-items:center;gap:0.7rem;padding:0.4rem 0.6rem;border-radius:6px;cursor:pointer;color:#ddd;font-family:monospace;font-size:0.85em;"><input type="checkbox" value="${f.path}" style="accent-color:#7c3aed;"> ${f.rel}</label>`).join('')}</div>
          <div style="display:flex;gap:1rem;justify-content:flex-end;">
            <button id="pick-cancel" style="padding:0.5rem 1.2rem;border-radius:8px;border:1px solid #555;background:transparent;color:#ddd;cursor:pointer;">Cancel</button>
            <button id="pick-confirm" style="padding:0.5rem 1.2rem;border-radius:8px;background:#7c3aed;border:none;color:white;cursor:pointer;">Confirm Selection</button>
          </div>
        </div>`;
        document.body.appendChild(overlay);
        document.getElementById('pick-cancel').onclick = () => document.body.removeChild(overlay);
        document.getElementById('pick-confirm').onclick = () => {
          selectedTargetFiles = Array.from(document.querySelectorAll('#file-pick-list input:checked')).map(i => i.value);
          const listEl = document.getElementById('target-files-list');
          listEl.innerHTML = selectedTargetFiles.length > 0
            ? selectedTargetFiles.map(f => `<span style="background:rgba(124,58,237,0.3);border:1px solid rgba(124,58,237,0.5);border-radius:20px;padding:0.2rem 0.7rem;font-size:0.8em;color:#c4b5fd;display:flex;align-items:center;gap:0.4rem;">${f.split(/[\\/]/).pop()} <span onclick="this.parentElement.remove(); selectedTargetFiles.splice(selectedTargetFiles.indexOf('${f}'),1);" style="cursor:pointer;opacity:0.7;">×</span></span>`).join('')
            : '<span style="color:var(--text-secondary);font-size:0.85em;align-self-center;">No files selected — Pavi will work on the whole project.</span>';
          pickFilesBtn._selectedFiles = selectedTargetFiles;
          document.body.removeChild(overlay);
        };
      } catch(e) { alert('Could not load file list. Is the server running?'); }
    });
  }

  const buildBtn = document.getElementById('unified-build-btn');
  if (buildBtn) {
    buildBtn.addEventListener('click', async () => {
      const prompt = document.getElementById('unified-prompt').value;
      let cwd = document.getElementById('magic-target-dir').value.trim();
      if (!cwd) cwd = undefined;
      const targetFiles = (document.getElementById('pick-files-btn')._selectedFiles) || [];

      if (!prompt) {
        alert("Please tell me what to build!");
        return;
      }

      // Add user message to UI
      const unifiedChatHistory = document.getElementById('unified-chat-history');
      const userMsg = document.createElement('div');
      userMsg.className = 'chat-message user';
      userMsg.style = 'align-self: flex-end; background: rgba(124, 58, 237, 0.2); border: 1px solid rgba(124, 58, 237, 0.5); padding: 1rem; border-radius: 8px; max-width: 80%; line-height: 1.5; font-family: var(--font-sans);';
      userMsg.textContent = prompt;
      unifiedChatHistory.appendChild(userMsg);
      unifiedChatHistory.scrollTop = unifiedChatHistory.scrollHeight;

      // Clear the prompt input
      document.getElementById('unified-prompt').value = '';
      
      document.getElementById('magic-status-container') && (document.getElementById('magic-status-container').style.display = 'block');
      const learnSpinner = document.getElementById('magic-learning-spinner');
      setBuildRunningState(true);
      if (learnSpinner) learnSpinner.style.display = 'none';
      
      addTimelineItem("Thinking...", `Understanding your request...`, "🤔");
      
      // If Orchestrator Config exists, use Dual-Model API with Planning Phase
      if (window.orchestratorConfig) {
          addTimelineItem("Drafting Plan...", "Creating implementation plan for approval.", "📝");
          
          try {
              const planRes = await fetch('/api/plan', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      prompt: prompt,
                      targetFiles: targetFiles,
                      apiUrl: window.orchestratorConfig.workerUrl,
                      apiModel: window.orchestratorConfig.workerModel,
                      apiKeys: window.orchestratorConfig.workerKeys,
                      reviewerUrl: window.orchestratorConfig.reviewerUrl,
                      reviewerModel: window.orchestratorConfig.reviewerModel,
                      reviewerKeys: window.orchestratorConfig.reviewerKeys
                  })
              });
              
              if (!planRes.ok) {
                  const errJson = await planRes.json().catch(() => ({}));
                  addTimelineItem("Encountered an Issue", errJson.error || "Failed to generate plan.", "❌");
                  setBuildRunningState(false);
                  return;
              }
              
              const planData = await planRes.json();
              if (planData.usedFallback) {
                  addTimelineItem("⚡ Escalation Triggered", "Local Bot unavailable — Groq (Reviewer API) stepped in to plan.", "🔄");
              }
              document.getElementById('plan-content').textContent = planData.plan || "No plan output.";
              
              const isAutonomous = document.getElementById('autonomous-toggle').checked;
              if (isAutonomous) {
                  addTimelineItem("Autonomous Mode", "Auto-approving plan for immediate execution...", "🚀");
                  // Small delay for UI readability
                  setTimeout(() => document.getElementById('approve-plan-btn').onclick(), 500);
                  return;
              }

              document.getElementById('plan-modal').style.display = 'flex';
              
              document.getElementById('reject-plan-btn').onclick = () => {
                  document.getElementById('plan-modal').style.display = 'none';
                  addTimelineItem("Aborted", "Plan was rejected by user.", "🛑");
                  setBuildRunningState(false);
              };
              
              document.getElementById('approve-plan-btn').onclick = async () => {
                  document.getElementById('plan-modal').style.display = 'none';
                  addTimelineItem("Plan Approved!", "Deploying Maker & Checker Engine...", "⚙️");
                  
                  try {
                      const response = await fetch('/api/orchestrate', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              ...window.orchestratorConfig,
                              prompt,
                              cwd,
                              targetFiles: (document.getElementById('pick-files-btn')._selectedFiles) || []
                          })
                      });
                      
                      if (!response.ok) {
                          addTimelineItem("Encountered an Issue", "Orchestrator failed to start.", "❌");
                          setBuildRunningState(false);
                          return;
                      }

                      if (response.body) {
                          const reader = response.body.getReader();
                          const decoder = new TextDecoder();
                          const magicOutput = document.getElementById('magic-cli-output');
                          magicOutput.textContent = ''; // clear it
                          
                          let rawBuffer = '';
                          
                          while (true) {
                              const { done, value } = await reader.read();
                              if (done) break;
                              let chunk = decoder.decode(value, { stream: true });
                              
                              if (typeof processMagicStreamChunk === 'function') {
                                  chunk = processMagicStreamChunk(chunk);
                              }
                              
                              magicOutput.textContent += chunk;
                              magicOutput.parentElement.scrollTop = magicOutput.parentElement.scrollHeight;
                              
                              rawBuffer += chunk;
                              let lines = rawBuffer.split('\n');
                              rawBuffer = lines.pop(); // Keep the last incomplete line in buffer
                              
                              for (const line of lines) {
                                  let chatMsg = null;
                                  if (line.includes('[WORKER] Writing file:')) {
                                      const file = line.split('Writing file:')[1].trim();
                                      chatMsg = `Generating \`${file}\`... ⏳`;
                                  } else if (line.includes('[WORKER] Running command:')) {
                                      const cmd = line.split('Running command:')[1].trim();
                                      chatMsg = `Running command \`${cmd}\`... ⚡`;
                                  } else if (line.includes('[WORKER] Finished task.')) {
                                      chatMsg = `Done with this step! ✅`;
                                  } else if (line.includes('[REVIEWER] Status: REJECTED!')) {
                                      chatMsg = `Wait, I found an issue. Fixing it now... 🛠️`;
                                  } else if (line.includes('Generating action...')) {
                                      chatMsg = `Thinking about the next step... 🤔`;
                                  }
                                  
                                  if (chatMsg) {
                                      const aiMsg = document.createElement('div');
                                      aiMsg.className = 'chat-message system';
                                      aiMsg.style = 'align-self: flex-start; background: rgba(99, 102, 241, 0.2); border: 1px solid rgba(99, 102, 241, 0.5); padding: 1rem; border-radius: 8px; max-width: 80%; line-height: 1.5; font-family: var(--font-sans);';
                                      aiMsg.innerHTML = chatMsg.replace(/`(.*?)`/g, '<code style="background: rgba(0,0,0,0.3); padding: 0.2rem 0.4rem; border-radius: 4px;">$1</code>');
                                      unifiedChatHistory.appendChild(aiMsg);
                                      unifiedChatHistory.scrollTop = unifiedChatHistory.scrollHeight;
                                  }
                              }
                          }
                      }
                      
                      addTimelineItem("Done! 🎉", "Prototype ready! Type your next instruction below.", "🎉");
                      learnSpinner.style.display = 'inline';
                      // set follow-up placeholder
                      const promptEl = document.getElementById('unified-prompt');
                      promptEl.placeholder = '✅ Done! Type a follow-up: "add animations", "change colors", "add a score counter"...';
                      promptEl.focus();
                  } catch (err) {
                      addTimelineItem("Connection Failed", "Could not reach the local AI engine.", "🔌");
                  } finally {
                      setBuildRunningState(false);
                  }
              };
          } catch (err) {
              addTimelineItem("Connection Failed", "Could not reach the planner API.", "🔌");
              setBuildRunningState(false);
          }
      } else {
          // Standard Single-Model CLI execution
          const command = `npx claude-flow swarm start --objective "${prompt.replace(/"/g, '\\"')}"`;
          try {
            const response = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command, cwd })
            });
            
            const data = await response.json();
            
            if (data.error || (data.stderr && data.stderr.toLowerCase().includes('error'))) {
              addTimelineItem("Encountered an Issue", "I ran into a problem while working on your request.", "❌");
              const errDetail = data.error || (data.stderr ? data.stderr.split('\n')[0] : 'Unknown error');
              addTimelineItem("Details", errDetail, "ℹ️");
            } else {
              addTimelineItem("Writing Code", "Automatically generating and saving files.", "💻");
              addTimelineItem("Done! 🎉", "Prototype ready! Type your next instruction below.", "🎉");
              // Clear textarea and set follow-up placeholder
              const promptEl = document.getElementById('unified-prompt');
              promptEl.placeholder = '✅ Done! Type a follow-up: "add animations", "change colors", "fix the bug"...';
              promptEl.focus();
            }
          } catch (err) {
            addTimelineItem("Connection Failed", "Could not reach the local AI engine. Is the server running?", "🔌");
          } finally {
            setBuildRunningState(false);
          }
      }
    });
  }

  // --- Harvester Logic ---
  const startHarvestBtn = document.getElementById('start-harvest-btn');
  if (startHarvestBtn) {
    startHarvestBtn.addEventListener('click', async () => {
      if (!window.orchestratorConfig) {
        alert("Please configure the 'Maker & Checker Engine' first! The Harvester uses its API settings.");
        return;
      }
      
      const apiUrl = window.orchestratorConfig.workerUrl;
      const apiKey = window.orchestratorConfig.workerKey;
      const apiModel = window.orchestratorConfig.workerModel;
      const topic = document.getElementById('harvest-topic').value;
      const loops = document.getElementById('harvest-loops').value;
      
      if (!topic) {
        alert("Please fill in the Seed Topic.");
        return;
      }
      
      document.getElementById('harvest-status-container').style.display = 'block';
      const spinner = document.getElementById('harvest-loading-spinner');
      const output = document.getElementById('harvest-cli-output');
      spinner.style.display = 'inline';
      output.textContent = "Starting harvest sequence...\\n";
      startHarvestBtn.disabled = true;
      
      try {
        const response = await fetch('/api/harvest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiUrl, apiKey, apiModel, topic, loops })
        });
        
        if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                output.textContent += chunk;
                output.parentElement.scrollTop = output.parentElement.scrollHeight;
            }
        } else {
            const text = await response.text();
            output.textContent += text;
        }
      } catch (err) {
        output.textContent += `\\n[ERROR]: ${err.message}`;
      } finally {
        spinner.style.display = 'none';
        startHarvestBtn.disabled = false;
      }
    });
  }

  // --- Dynamic Model Discovery ---
  const discoverModelsBtn = document.getElementById('discover-models-btn');
  if (discoverModelsBtn) {
    discoverModelsBtn.addEventListener('click', async () => {
      const customUrlInput = document.getElementById('worker-custom-url');
      const customUrl = customUrlInput ? customUrlInput.value.trim() : 'http://localhost:11434';
      if (!customUrl) {
        alert("Please enter a custom Ollama endpoint URL.");
        return;
      }
      
      discoverModelsBtn.disabled = true;
      discoverModelsBtn.textContent = "Discovering...";
      
      try {
        const res = await fetch(`/api/models?url=${encodeURIComponent(customUrl)}`);
        const data = await res.json();
        
        if (data.ok && data.models && data.models.length > 0) {
          const workerProvider = document.getElementById('worker-provider');
          if (workerProvider) {
            // Normalize URL for option value
            let normUrl = customUrl;
            if (!normUrl.includes('/v1/chat/completions') && !normUrl.includes('/v1')) {
              normUrl = normUrl.replace(/\/$/, '') + '/v1/chat/completions';
            }
            
            // Add options
            let selectedVal = null;
            data.models.forEach(model => {
              const val = `${normUrl}|${model}`;
              // Check if option already exists
              let exists = false;
              for (let i = 0; i < workerProvider.options.length; i++) {
                if (workerProvider.options[i].value === val) {
                  exists = true;
                  break;
                }
              }
              if (!exists) {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = `${model} (Ollama - ${customUrl})`;
                workerProvider.appendChild(opt);
              }
              if (!selectedVal) {
                selectedVal = val;
              }
            });
            
            if (selectedVal) {
              workerProvider.value = selectedVal;
            }
            alert(`Discovered ${data.models.length} model(s) successfully!`);
          }
        } else {
          alert(`Could not discover models: ${data.error || 'No models returned from endpoint'}`);
        }
      } catch (err) {
        console.error("Failed to discover models", err);
        alert(`Failed to query endpoint: ${err.message}`);
      } finally {
        discoverModelsBtn.disabled = false;
        discoverModelsBtn.textContent = "Discover Models";
      }
    });
  }

  // --- Orchestrator Config Logic ---
  const saveEngineBtn = document.getElementById('save-config-btn');
  if (saveEngineBtn) {
    saveEngineBtn.addEventListener('click', () => {
      const workerProvider = document.getElementById('worker-provider').value;
      const workerUrl = workerProvider.split('|')[0];
      const workerModel = workerProvider.split('|')[1];
      const workerKeys = document.getElementById('worker-key').value.split('\n').map(k => k.trim()).filter(k => k);
      
      const reviewerProvider = document.getElementById('reviewer-provider').value;
      const reviewerUrl = reviewerProvider.split('|')[0];
      const reviewerModel = reviewerProvider.split('|')[1];
      const reviewerKeys = document.getElementById('reviewer-key').value.split('\n').map(k => k.trim()).filter(k => k);
      
      const isWorkerLocal = workerUrl.includes('localhost') || workerUrl.includes('127.0.0.1') || workerUrl.includes('192.168.') || workerUrl.includes('10.') || workerUrl.includes('172.');
      const isReviewerLocal = reviewerUrl.includes('localhost') || reviewerUrl.includes('127.0.0.1') || reviewerUrl.includes('192.168.') || reviewerUrl.includes('10.') || reviewerUrl.includes('172.');

      if (!workerUrl || !reviewerUrl) {
        alert("Please select a provider for both Worker and Reviewer models.");
        return;
      }

      if ((!isWorkerLocal && workerKeys.length === 0) || (!isReviewerLocal && reviewerKeys.length === 0)) {
        alert("Please fill in API Keys for external models. (Local / LAN models do not require keys).");
        return;
      }
      
      // Inject dummy key for local models so the key-rotation loops don't break
      if (isWorkerLocal && workerKeys.length === 0) workerKeys.push('local_mode');
      if (isReviewerLocal && reviewerKeys.length === 0) reviewerKeys.push('local_mode');
      
      window.orchestratorConfig = {
        workerUrl,
        workerModel,
        workerKeys,
        workerKey: workerKeys[0],
        reviewerUrl,
        reviewerModel,
        reviewerKeys,
        reviewerKey: reviewerKeys[0]
      };
      
      // Save to backend configuration file
      fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(window.orchestratorConfig)
      }).then(res => {
          if (!res.ok) throw new Error("Server returned " + res.status);
          return res.json();
      }).then(data => {
          if (data.success || data.ok) {
              const saveToast = document.getElementById('save-toast');
              saveToast.style.display = 'block';
              setTimeout(() => {
                saveToast.style.display = 'none';
              }, 4000);
          } else {
              throw new Error("Backend response not successful");
          }
      }).catch(err => {
          console.error("Failed to save config to backend", err);
          alert("Failed to save config to backend. Check console for details.");
      });
    });
  }

  // --- Zip Ingestion Logic ---
  const startZipBtn = document.getElementById('start-zip-ingest-btn');
  if (startZipBtn) {
      startZipBtn.addEventListener('click', async () => {
          const zipPath = document.getElementById('zip-file-path').value;
          const topicHint = document.getElementById('zip-topic-hint').value || "General Codebase Analysis";
          
          if (!zipPath) {
              alert("Please select a Zip file to ingest.");
              return;
          }
          if (!window.orchestratorConfig) {
              alert("Please configure the 'Maker & Checker Engine' first! Pavi needs API keys to read and verify the code.");
              return;
          }

          document.getElementById('zip-status-container').style.display = 'block';
          const spinner = document.getElementById('zip-loading-spinner');
          const output = document.getElementById('zip-cli-output');
          spinner.style.display = 'inline';
          output.textContent = "Initiating Brain Dump sequence...\\n";
          startZipBtn.disabled = true;

          try {
              const response = await fetch('/api/ingest-zip', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      zipPath,
                      topicHint,
                      workerUrl: window.orchestratorConfig.workerUrl,
                      workerModel: window.orchestratorConfig.workerModel,
                      workerKeys: window.orchestratorConfig.workerKeys,
                      reviewerUrl: window.orchestratorConfig.reviewerUrl,
                      reviewerModel: window.orchestratorConfig.reviewerModel,
                      reviewerKeys: window.orchestratorConfig.reviewerKeys
                  })
              });

              if (response.body) {
                  const reader = response.body.getReader();
                  const decoder = new TextDecoder();
                  let streamBuffer = '';
                  while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      const chunk = decoder.decode(value, { stream: true });
                      streamBuffer += chunk;
                      
                      // Auto-apply secret keys found in zip
                      const keyMatch = streamBuffer.match(/\[SECRET_KEY_FOUND\]\s*(\S+)/);
                      if (keyMatch) {
                          const newKey = keyMatch[1];
                          if (window.orchestratorConfig) {
                              if (!window.orchestratorConfig.workerKeys.includes(newKey)) {
                                  window.orchestratorConfig.workerKeys.push(newKey); // Add to key pool
                              }
                              
                              // Visual alert in timeline
                              const list = document.getElementById('timeline-list');
                              if (list) {
                                const li = document.createElement('li');
                                li.innerHTML = `<span class="icon">🔑</span><div class="details"><h4>Secret Key Extracted!</h4><p>Found a hidden API key in the zip. Added to your key pool to bypass rate limits!</p></div>`;
                                list.appendChild(li);
                              }
                          }
                          // Remove from buffer so we don't trigger it again
                          streamBuffer = streamBuffer.replace(/\[SECRET_KEY_FOUND\]\s*(\S+)/, '[KEY SECURED]');
                      }
                      
                      // Avoid buffer infinitely growing
                      if (streamBuffer.length > 2000) streamBuffer = streamBuffer.slice(-2000);

                      output.textContent += chunk;
                      if (output && output.parentElement) output.parentElement.scrollTop = output.parentElement.scrollHeight;
                  }
              } else {
                  const text = await response.text();
                  output.textContent += text;
              }
          } catch (err) {
              output.textContent += `\\n[ERROR]: ${err.message}`;
          } finally {
              spinner.style.display = 'none';
              startZipBtn.disabled = false;
          }
      });
  }
  
  // --- Unified Chat Space Logic ---
  const chatAskBtn = document.getElementById('unified-chat-btn');
  const chatInput = document.getElementById('unified-prompt');
  const chatHistoryUI = document.getElementById('unified-chat-history');
  
  let paviChatHistory = []; // Local state array of messages

  if (chatAskBtn && chatInput && chatHistoryUI) {
      chatAskBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          const question = chatInput.value.trim();
          if (!question) return;

          if (!window.orchestratorConfig) {
              alert("Please configure the 'Maker & Checker Engine' first! Pavi Chat needs API keys to answer questions.");
              return;
          }

          // Add user message to UI
          const userMsg = document.createElement('div');
          userMsg.className = 'chat-message user';
          userMsg.style = 'align-self: flex-end; background: rgba(124, 58, 237, 0.2); border: 1px solid rgba(124, 58, 237, 0.5); padding: 1rem; border-radius: 8px; max-width: 80%; line-height: 1.5; font-family: var(--font-sans);';
          userMsg.textContent = question;
          chatHistoryUI.appendChild(userMsg);

          // Add to local state history
          paviChatHistory.push({ role: 'user', content: question });

          chatInput.value = '';
          chatAskBtn.disabled = true;
          chatAskBtn.textContent = 'Thinking...';
          
          chatHistoryUI.scrollTop = chatHistoryUI.scrollHeight;

          try {
              const response = await fetch('/api/route-chat', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      messages: paviChatHistory,
                      role: 'worker',
                      source: 'desktop',
                      systemPrompt: "You are Pavi Chat, an AI assistant built into the Pavi Dashboard. Your job is to answer questions, explain concepts, and help the user understand their codebase and projects. Be concise and helpful. Format your responses using markdown."
                  })
              });

              if (!response.ok) {
                  throw new Error(`HTTP ${response.status}`);
              }

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let done = false;
              let buffer = '';
              
              let aiMsg = null;
              let rawContent = '';
              let routingResolved = false;

              while (!done) {
                  const { value, done: doneReading } = await reader.read();
                  done = doneReading;
                  if (value) {
                      buffer += decoder.decode(value, { stream: !done });
                      const lines = buffer.split('\n');
                      buffer = lines.pop();

                      for (const line of lines) {
                          const cleanLine = line.trim();
                          if (!cleanLine) continue;

                          if (cleanLine.startsWith('[ROUTING] ')) {
                              const routingData = cleanLine.slice(10);
                              routingResolved = true;
                              if (routingData.startsWith('swarm')) {
                                  const parts = routingData.split('|');
                                  const botsJson = parts[1] || '[]';
                                  let bots = [];
                                  try { bots = JSON.parse(botsJson); } catch(e) {}
                                  
                                  const badge = document.createElement('div');
                                  badge.style = 'align-self:flex-start; background:rgba(234,179,8,0.15); border:1px solid rgba(234,179,8,0.4); color:#fbbf24; font-size:.75rem; padding:.3rem .7rem; border-radius:20px; margin-bottom:.3rem;';
                                  badge.textContent = '🐝 Swarm Mode Activated';
                                  chatHistoryUI.appendChild(badge);

                                  if (bots.length > 0) {
                                      const botList = document.createElement('div');
                                      botList.style = 'align-self:flex-start; font-size:0.85rem; color:var(--text-secondary); margin: 0.5rem 0 1rem 1rem; line-height:1.6;';
                                      botList.innerHTML = '<strong>Specialists assigned:</strong><br>' + 
                                          bots.map(b => `• <strong>${b.name}</strong> (${b.role})`).join('<br>');
                                      chatHistoryUI.appendChild(botList);
                                  }
                              } else {
                                  const badge = document.createElement('div');
                                  badge.style = 'align-self:flex-start; background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.4); color:#60a5fa; font-size:.75rem; padding:.3rem .7rem; border-radius:20px; margin-bottom:.3rem;';
                                  badge.textContent = '🤖 Single-Bot Mode';
                                  chatHistoryUI.appendChild(badge);
                              }
                              continue;
                          }

                          if (cleanLine.startsWith('[TOKEN] ')) {
                              const token = cleanLine.slice(8);
                              rawContent += token;
                              if (!aiMsg) {
                                  aiMsg = document.createElement('div');
                                  aiMsg.className = 'chat-message system';
                                  aiMsg.style = 'align-self: flex-start; background: rgba(99, 102, 241, 0.2); border: 1px solid rgba(99, 102, 241, 0.5); padding: 1rem; border-radius: 8px; max-width: 80%; line-height: 1.5; font-family: var(--font-sans); white-space: pre-wrap;';
                                  chatHistoryUI.appendChild(aiMsg);
                              }
                              let formatted = rawContent.replace(/\n/g, '<br>');
                              formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                              aiMsg.innerHTML = formatted;
                              chatHistoryUI.scrollTop = chatHistoryUI.scrollHeight;
                              continue;
                          }

                          if (cleanLine.startsWith('[CONTENT] ')) {
                              const content = cleanLine.slice(10);
                              rawContent += content;
                              if (!aiMsg) {
                                  aiMsg = document.createElement('div');
                                  aiMsg.className = 'chat-message system';
                                  aiMsg.style = 'align-self: flex-start; background: rgba(99, 102, 241, 0.2); border: 1px solid rgba(99, 102, 241, 0.5); padding: 1rem; border-radius: 8px; max-width: 80%; line-height: 1.5; font-family: var(--font-sans); white-space: pre-wrap;';
                                  chatHistoryUI.appendChild(aiMsg);
                              }
                              let formatted = rawContent.replace(/\n/g, '<br>');
                              formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                              aiMsg.innerHTML = formatted;
                              chatHistoryUI.scrollTop = chatHistoryUI.scrollHeight;
                              continue;
                          }

                          if (cleanLine.startsWith('[ERROR] ')) {
                              const errMsg = cleanLine.slice(8);
                              const errorBlock = document.createElement('div');
                              errorBlock.style = 'align-self: flex-start; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); padding: 1rem; border-radius: 8px; max-width: 80%; margin-top: 0.5rem;';
                              errorBlock.textContent = `Error: ${errMsg}`;
                              chatHistoryUI.appendChild(errorBlock);
                              chatHistoryUI.scrollTop = chatHistoryUI.scrollHeight;
                              continue;
                          }
                      }
                  }
              }
              
              if (rawContent) {
                  paviChatHistory.push({ role: 'assistant', content: rawContent });
              }

          } catch (err) {
              const errorMsg = document.createElement('div');
              errorMsg.style = 'align-self: flex-start; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); padding: 1rem; border-radius: 8px; max-width: 80%;';
              errorMsg.textContent = `Connection failed: ${err.message}`;
              chatHistoryUI.appendChild(errorMsg);
          } finally {
              chatAskBtn.disabled = false;
              chatAskBtn.textContent = 'Chat 💬';
              chatHistoryUI.scrollTop = chatHistoryUI.scrollHeight;
          }
      });
  }

  // Load Dynamic Skills
  const loadSkills = async () => {
      const skillsContainer = document.getElementById('dynamic-skills-list');
      if (!skillsContainer) return;
      try {
          const res = await fetch('/api/skills');
          if (res.ok) {
              const skills = await res.json();
              skillsContainer.innerHTML = '';
              skills.forEach(skill => {
                  const tag = document.createElement('div');
                  tag.className = 'skill-tag';
                  tag.title = skill.description;
                  tag.textContent = skill.tag;
                  skillsContainer.appendChild(tag);
              });
          }
      } catch (e) {
          skillsContainer.innerHTML = '<div class="skill-tag" style="opacity:0.5; color:red;">Failed to load skills.</div>';
      }
  };
  // --- Cloud Sync & Export Logic ---
  const exportBtn = document.getElementById('export-snapshot-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      window.location.href = '/api/export';
    });
  }

  const syncMode = document.getElementById('sync-mode');
  if (syncMode) {
    syncMode.addEventListener('change', () => {
      const settings = document.getElementById('sync-settings');
      const hostGroup = document.getElementById('sync-host-group');
      const portGroup = document.getElementById('sync-port-group');
      
      if (syncMode.value === 'off') {
        settings.style.display = 'none';
      } else {
        settings.style.display = 'block';
        hostGroup.style.display = (syncMode.value === 'client') ? 'block' : 'none';
      }
    });
  }

  const applySyncBtn = document.getElementById('apply-sync-btn');
  if (applySyncBtn) {
    applySyncBtn.addEventListener('click', async () => {
      const mode = syncMode.value;
      const port = document.getElementById('sync-port').value;
      const host = document.getElementById('sync-host').value;
      const token = document.getElementById('sync-token').value;
      const log = document.getElementById('sync-status-log');
      
      if (!token) { alert("Please enter an Auth Token"); return; }
      
      log.textContent = `Initiating sync (${mode})...`;
      try {
        const res = await fetch('/api/sync-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, port, host, token })
        });
        const data = await res.json();
        log.textContent = `Status: ${data.status || data.error}`;
      } catch (err) {
        log.textContent = `Error: ${err.message}`;
      }
    });
  }

  const importInput = document.getElementById('import-snapshot-input');
  const importBtn = document.getElementById('import-snapshot-btn');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files[0];
      if (!file) return;
      
      const log = document.getElementById('sync-status-log');
      log.textContent = `Importing snapshot: ${file.name}...`;
      
      try {
        const res = await fetch('/api/import', {
          method: 'POST',
          body: file
        });
        const data = await res.json();
        alert(data.status || data.error);
        location.reload(); // Refresh to apply changes
      } catch (err) {
        log.textContent = `Import Error: ${err.message}`;
      }
    });
  }

  // Mobile Connect is initialized earlier in the DOMContentLoaded block (initMobileConnect)

  loadSkills();

  // ═══════════════════════════════════════════════════════════════
  // BOT ROLES REGISTRY UI
  // ═══════════════════════════════════════════════════════════════

  const ROLE_ICONS = { coder: '💻', tester: '🧪', architect: '🏗️', reviewer: '🔍', coordinator: '🎯', researcher: '🔬', security: '🛡️' };

  function renderBotCard(bot) {
      const active = bot.active !== false;
      const roleIcon = ROLE_ICONS[bot.role] || '🤖';
      const card = document.createElement('div');
      card.className = 'card glass-card';
      card.dataset.botName = bot.name;
      card.style = `position:relative; padding:1rem; border-radius:12px; border:1px solid ${ active ? 'rgba(124,58,237,0.4)' : 'rgba(100,100,100,0.3)' }; background:rgba(0,0,0,0.2); transition:opacity .2s; opacity:${ active ? '1' : '0.5' };`;
      card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:.5rem;">
              <span style="font-size:1.3rem;">${roleIcon}</span>
              <span style="font-size:.7rem; padding:.2rem .5rem; border-radius:10px; background:rgba(124,58,237,0.15); color:#a78bfa;">${bot.version || '1.0.0'}</span>
          </div>
          <div style="font-weight:700; margin-bottom:.2rem;">${bot.name}</div>
          <div style="font-size:.8rem; opacity:.7; margin-bottom:.3rem;">Role: ${bot.role}${bot.language ? ' · ' + bot.language : ''}</div>
          ${bot.description ? `<div style="font-size:.78rem; opacity:.6; margin-bottom:.6rem; line-height:1.4;">${bot.description}</div>` : ''}
          ${bot.source ? `<div style="font-size:.72rem; opacity:.5;">📦 ${bot.source}</div>` : ''}
          <div style="display:flex; gap:.4rem; margin-top:.8rem; flex-wrap:wrap;">
              <button class="btn-bot-toggle" data-name="${bot.name}" style="flex:1; font-size:.75rem; padding:.35rem; border-radius:6px; border:1px solid rgba(100,100,100,0.4); background:transparent; cursor:pointer; color:var(--text-primary);">${active ? '⏸ Deactivate' : '▶ Activate'}</button>
              <button class="btn-bot-upgrade" data-name="${bot.name}" style="font-size:.75rem; padding:.35rem .6rem; border-radius:6px; border:1px solid rgba(124,58,237,0.4); background:rgba(124,58,237,0.1); cursor:pointer; color:#a78bfa;">⬆ Upgrade</button>
              <button class="btn-bot-delete" data-name="${bot.name}" style="font-size:.75rem; padding:.35rem .6rem; border-radius:6px; border:1px solid rgba(239,68,68,0.4); background:rgba(239,68,68,0.1); cursor:pointer; color:#f87171;">🗑</button>
          </div>
      `;
      return card;
  }

  async function loadBotRoles() {
      const grid = document.getElementById('bot-roles-grid');
      if (!grid) return;
      try {
          const res = await fetch('/api/bots');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bots = await res.json();

          grid.innerHTML = '';
          if (!bots || bots.length === 0) {
              grid.innerHTML = '<div id="bot-roles-empty" style="grid-column:1/-1; text-align:center; opacity:0.5; padding:2rem;"><div style="font-size:2rem;">🤖</div><p>No bots registered yet.<br>Import a bot pack above or use the default Swarm agents.</p></div>';
              return;
          }

          bots.forEach(bot => grid.appendChild(renderBotCard(bot)));

          // Toggle
          grid.querySelectorAll('.btn-bot-toggle').forEach(btn => {
              btn.addEventListener('click', async () => {
                  const name = btn.dataset.name;
                  await fetch(`/api/bots/${encodeURIComponent(name)}/toggle`, { method: 'POST' });
                  loadBotRoles();
              });
          });

          // Upgrade
          grid.querySelectorAll('.btn-bot-upgrade').forEach(btn => {
              btn.addEventListener('click', async () => {
                  const name = btn.dataset.name;
                  btn.textContent = 'Upgrading...';
                  const res = await fetch(`/api/bots/${encodeURIComponent(name)}/upgrade`, { method: 'POST' });
                  const result = await res.json();
                  alert(result.message);
                  loadBotRoles();
              });
          });

          // Delete
          grid.querySelectorAll('.btn-bot-delete').forEach(btn => {
              btn.addEventListener('click', async () => {
                  const name = btn.dataset.name;
                  if (!confirm(`Remove bot "${name}"?`)) return;
                  await fetch(`/api/bots/${encodeURIComponent(name)}`, { method: 'DELETE' });
                  loadBotRoles();
              });
          });

      } catch (e) {
          if (grid) grid.innerHTML = `<div style="opacity:.5; padding:1rem;">⚠️ Failed to load bots: ${e.message}</div>`;
      }
  }

  // Bot pack ingest button
  const botIngestBtn = document.getElementById('bot-ingest-btn');
  const botPackUrl  = document.getElementById('bot-pack-url');
  const botStatus   = document.getElementById('bot-ingest-status');
  if (botIngestBtn && botPackUrl) {
      botIngestBtn.addEventListener('click', async () => {
          const url = botPackUrl.value.trim();
          if (!url) { alert('Please enter a GitHub URL first.'); return; }
          botIngestBtn.disabled = true;
          botIngestBtn.textContent = '⏳ Importing...';
          botStatus.textContent = '';
          try {
              const res = await fetch('/api/bot-ingest', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url })
              });
              const data = await res.json();
              if (data.error) throw new Error(data.error);
              botStatus.textContent = `✅ Done! ${data.added} bot(s) added/upgraded, ${data.skipped} skipped.`;
              botStatus.style.color = '#4ade80';
              botPackUrl.value = '';
              loadBotRoles();
          } catch (e) {
              botStatus.textContent = `❌ ${e.message}`;
              botStatus.style.color = '#f87171';
          } finally {
              botIngestBtn.disabled = false;
              botIngestBtn.textContent = '⬇️ Import Bots';
          }
      });
  }

  // Scan Local Skills button
  const scanSkillsBtn = document.getElementById('scan-skills-btn');
  if (scanSkillsBtn) {
      scanSkillsBtn.addEventListener('click', async () => {
          scanSkillsBtn.disabled = true;
          scanSkillsBtn.textContent = '⏳ Scanning...';
          const botStatus = document.getElementById('bot-ingest-status');
          if (botStatus) { botStatus.textContent = ''; }
          try {
              const res = await fetch('/api/scan-skills', { method: 'POST' });
              const data = await res.json();
              if (data.error) throw new Error(data.error);
              if (botStatus) {
                  botStatus.textContent = `✅ Scanned! ${data.added} skills registered, ${data.skipped} skipped.`;
                  botStatus.style.color = '#4ade80';
              }
              loadBotRoles();
          } catch (e) {
              if (botStatus) {
                  botStatus.textContent = `❌ Scan failed: ${e.message}`;
                  botStatus.style.color = '#f87171';
              }
          } finally {
              scanSkillsBtn.disabled = false;
              scanSkillsBtn.textContent = '🔍 Scan Local Skills (134 found)';
          }
      });
  }

  // Listen for swarm_result SSE events and show them in chat
  document.addEventListener('pavi-sse', (e) => {
      const { type, data } = e.detail || {};
      if (type === 'swarm_result') {
          const chatHistoryUI = document.getElementById('unified-chat-history');
          if (!chatHistoryUI) return;
          const msg = document.createElement('div');
          msg.className = 'chat-message system';
          msg.style = 'align-self:flex-start; background:rgba(234,179,8,0.1); border:1px solid rgba(234,179,8,0.4); padding:1rem; border-radius:8px; max-width:90%; line-height:1.5; white-space:pre-wrap;';
          msg.innerHTML = `<strong>🐝 Swarm Result</strong><br><small style="opacity:.6;">Task: ${data.objective}</small><br><br>${(data.result || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`;
          chatHistoryUI.appendChild(msg);
          chatHistoryUI.scrollTop = chatHistoryUI.scrollHeight;
      }

      if (type === 'phase_d:status') {
          addTimelineItem("CI/CD Pipeline Status", `[Job #${data.jobId}] Issue #${data.issueNumber}: ${data.message}`, "🔄");
      }

      if (type === 'phase_d:plan_ready') {
          addTimelineItem("CI/CD Plan Ready 📋", `[Job #${data.jobId}] Issue #${data.issueNumber}: Technical plan generated successfully.`, "📋");
      }

      if (type === 'phase_d:completed') {
          addTimelineItem("CI/CD Completed 🎉", `[Job #${data.jobId}] Issue #${data.issueNumber} completed! Pull Request created: <a href="${data.prUrl}" target="_blank" style="color:var(--accent-primary);font-weight:600;text-decoration:underline;">#${data.prNumber}</a>`, "🎉");
          loadSwarmHistory();
      }

      if (type === 'phase_d:failed') {
          addTimelineItem("CI/CD Failed ❌", `[Job #${data.jobId}] Issue #${data.issueNumber} failed: ${data.reason}. Details: ${data.details || ''}`, "❌");
          loadSwarmHistory();
      }

      if (type === 'pending_change_added' || type === 'pending_changes_update') {
          loadPendingChanges();
          
          if (type === 'pending_change_added') {
              const chatHistoryUI = document.getElementById('unified-chat-history');
              if (chatHistoryUI) {
                  const msg = document.createElement('div');
                  msg.className = 'chat-message system';
                  msg.style = 'align-self:flex-start; background:rgba(99,102,241,0.1); border:1px solid rgba(99,102,241,0.3); padding:0.75rem; border-radius:8px; max-width:85%; line-height:1.4; margin-bottom: 0.5rem;';
                  
                  const fullPath = data.file_path || '';
                  const fileName = fullPath.substring(Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\')) + 1);
                  
                  msg.innerHTML = `<strong>📝 Intercepted Write Action</strong><br>
                                   <span style="font-size:0.85em; opacity:0.8;">A file write to <code>${fileName}</code> was intercepted for security review.</span><br>
                                   <a href="#" class="review-link" style="color:var(--accent-primary); font-weight:bold; font-size:0.85em; text-decoration:underline;">Review & Approve</a>`;
                  msg.querySelector('a').addEventListener('click', (ev) => {
                      ev.preventDefault();
                      // Switch to Write Audit panel
                      document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.remove('active'));
                      const writeAuditLink = document.querySelector('.sidebar-nav a[data-target="pending-panel"]');
                      if (writeAuditLink) {
                          writeAuditLink.parentElement.classList.add('active');
                      }
                      document.querySelectorAll('.panel').forEach(panel => {
                          if (panel.id === 'pending-panel') {
                              panel.classList.add('active');
                          } else {
                              panel.classList.remove('active');
                          }
                      });
                      if (data.id) selectPendingChange(data.id);
                  });
                  chatHistoryUI.appendChild(msg);
                  chatHistoryUI.scrollTop = chatHistoryUI.scrollHeight;
              }
          }
      }
  });

  // ═══════════════════════════════════════════════════════════════
  // SUPREME ARCHITECT PANEL FRONTEND ORCHESTRATOR
  // ═══════════════════════════════════════════════════════════════

  async function loadArchitectDiagnostics() {
      // 1. Database Sync & Config Diagnostics
      try {
          const res = await fetch('/api/db-sync');
          const dbBadge = document.getElementById('diag-db-badge');
          const dbDetails = document.getElementById('diag-db-details');
          if (dbBadge && dbDetails) {
              if (res.ok) {
                  const data = await res.json();
                  if (data.inSync) {
                      dbBadge.style.background = 'rgba(16, 185, 129, 0.15)';
                      dbBadge.style.color = '#10b981';
                      dbBadge.textContent = 'In Sync';
                  } else {
                      dbBadge.style.background = 'rgba(245, 158, 11, 0.15)';
                      dbBadge.style.color = '#f59e0b';
                      dbBadge.textContent = 'Degraded';
                  }
                  dbDetails.textContent = `Flat skills/bots: ${data.flat.skills}/${data.flat.bots} | SQLite tables: ${data.sqlite.skills}/${data.sqlite.bots}`;
              } else {
                  dbBadge.style.background = 'rgba(239, 68, 68, 0.15)';
                  dbBadge.style.color = '#ef4444';
                  dbBadge.textContent = 'Sync Error';
                  dbDetails.textContent = 'Failed to load SQLite sync counts.';
              }
          }
      } catch (err) {
          console.error('[ARCH-UI] Error checking db-sync:', err);
      }

      // 2. Health & Diagnostics (Ollama & Config)
      try {
          const res = await fetch('/api/health');
          const cfgBadge = document.getElementById('diag-config-badge');
          const cfgDetails = document.getElementById('diag-config-details');
          const olmBadge = document.getElementById('diag-ollama-badge');
          const olmDetails = document.getElementById('diag-ollama-details');
          
          if (res.ok) {
              const report = await res.json();
              
              // Config status
              if (cfgBadge && cfgDetails) {
                  const cfg = report.components.config || {};
                  if (cfg.status === 'ok') {
                      cfgBadge.style.background = 'rgba(16, 185, 129, 0.15)';
                      cfgBadge.style.color = '#10b981';
                      cfgBadge.textContent = 'Active';
                      cfgDetails.textContent = cfg.details || 'Loaded config.json successfully';
                  } else if (cfg.status === 'warn') {
                      cfgBadge.style.background = 'rgba(245, 158, 11, 0.15)';
                      cfgBadge.style.color = '#f59e0b';
                      cfgBadge.textContent = 'Fallback';
                      cfgDetails.textContent = cfg.details || 'Using environment defaults';
                  } else {
                      cfgBadge.style.background = 'rgba(239, 68, 68, 0.15)';
                      cfgBadge.style.color = '#ef4444';
                      cfgBadge.textContent = 'Invalid';
                      cfgDetails.textContent = cfg.error || 'Syntax or structure error';
                  }
              }

              // Ollama status
              if (olmBadge && olmDetails) {
                  const olm = report.components.ollama || {};
                  if (olm.status === 'ok') {
                      olmBadge.style.background = 'rgba(16, 185, 129, 0.15)';
                      olmBadge.style.color = '#10b981';
                      olmBadge.textContent = 'Online';
                      const models = olm.models || [];
                      olmDetails.textContent = `Connected (Models: ${models.join(', ') || 'None discovered'})`;
                  } else {
                      olmBadge.style.background = 'rgba(245, 158, 11, 0.15)';
                      olmBadge.style.color = '#f59e0b';
                      olmBadge.textContent = 'Offline';
                      olmDetails.textContent = olm.error || 'Port 11434 is closed (Ollama not running)';
                  }
              }
          } else {
              if (cfgBadge && cfgDetails) {
                  cfgBadge.style.background = 'rgba(239, 68, 68, 0.15)';
                  cfgBadge.style.color = '#ef4444';
                  cfgBadge.textContent = 'Failed';
                  cfgDetails.textContent = 'Diagnostics endpoint offline.';
              }
              if (olmBadge && olmDetails) {
                  olmBadge.style.background = 'rgba(239, 68, 68, 0.15)';
                  olmBadge.style.color = '#ef4444';
                  olmBadge.textContent = 'Failed';
                  olmDetails.textContent = 'Diagnostics endpoint offline.';
              }
          }
      } catch (err) {
          console.error('[ARCH-UI] Error checking health/diagnostics:', err);
      }
  }

  async function loadStagedSkills() {
      const list = document.getElementById('staged-skills-list');
      if (!list) return;
      
      try {
          const res = await fetch('/api/architect/staged');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { staged } = await res.json();
          
          if (!staged || staged.length === 0) {
              list.innerHTML = `
                <div style="text-align: center; opacity: 0.5; padding: 2rem;">
                  <div style="font-size: 2rem;">🌾</div>
                  <p>No skills currently in staging.<br>They will appear when capability gaps are analyzed.</p>
                </div>`;
              return;
          }
          
          list.innerHTML = staged.map(skill => {
              const scorePct = Math.round((skill.confidence || 0.8) * 100);
              const skeletonCount = Array.isArray(skill.skeletons) ? skill.skeletons.length : (skill.skeletons ? 1 : 0);
              
              return `
                <div class="card glass-card staged-card" style="padding: 1rem; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.02); border-radius: 10px; margin-bottom: 0.75rem;">
                  <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
                    <div style="font-weight: 700; color: #a78bfa; font-size: 1rem;">⚡ ${skill.tag}</div>
                    <span class="badge" style="background: rgba(167, 139, 250, 0.15); color: #c084fc; font-size: 0.72rem; padding: 2px 8px; border-radius: 12px; font-family: monospace;">Confidence: ${scorePct}%</span>
                  </div>
                  
                  <div style="font-size: 0.82rem; opacity: 0.8; margin-bottom: 0.75rem; line-height: 1.4;">${skill.description}</div>
                  
                  <!-- Metadata Row -->
                  <div style="display: flex; gap: 1rem; font-size: 0.72rem; opacity: 0.5; margin-bottom: 1rem; flex-wrap: wrap;">
                    <span>📂 Source: ${skill.source || 'Intake Extract'}</span>
                    <span>💀 Skeletons: ${skeletonCount} verified</span>
                  </div>

                  <!-- Action Buttons -->
                  <div style="display: flex; gap: 0.5rem;">
                    <button class="btn btn-primary btn-promote-skill" data-id="${skill.id}" style="flex: 1; padding: 0.4rem; font-size: 0.78rem; border-radius: 6px;">
                      🚀 Promote (Make Live)
                    </button>
                    <button class="btn btn-secondary btn-discard-skill" data-id="${skill.id}" style="padding: 0.4rem 0.8rem; font-size: 0.78rem; border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171;">
                      🗑 Discard
                    </button>
                  </div>
                </div>
              `;
          }).join('');
          
          // Wire up event listeners
          list.querySelectorAll('.btn-promote-skill').forEach(btn => {
              btn.addEventListener('click', async () => {
                  const id = btn.dataset.id;
                  btn.disabled = true;
                  btn.textContent = 'Promoting...';
                  try {
                      const response = await fetch('/api/architect/promote', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ id })
                      });
                      const resData = await response.json();
                      if (resData.success) {
                          alert(`Success: ${resData.message}`);
                          loadArchitectData();
                      } else {
                          alert(`Failed: ${resData.message || resData.error}`);
                          btn.disabled = false;
                          btn.textContent = '🚀 Promote (Make Live)';
                      }
                  } catch (e) {
                      alert(`Error during promotion: ${e.message}`);
                      btn.disabled = false;
                      btn.textContent = '🚀 Promote (Make Live)';
                  }
              });
          });

          list.querySelectorAll('.btn-discard-skill').forEach(btn => {
              btn.addEventListener('click', async () => {
                  const id = btn.dataset.id;
                  if (!confirm('Are you sure you want to discard this staged skill proposal?')) return;
                  btn.disabled = true;
                  btn.textContent = 'Discarding...';
                  try {
                      const response = await fetch('/api/architect/discard', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ id })
                      });
                      const resData = await response.json();
                      if (resData.success) {
                          loadArchitectData();
                      } else {
                          alert(`Failed to discard: ${resData.message || resData.error}`);
                          btn.disabled = false;
                          btn.textContent = '🗑 Discard';
                      }
                  } catch (e) {
                      alert(`Error: ${e.message}`);
                      btn.disabled = false;
                      btn.textContent = '🗑 Discard';
                  }
              });
          });
          
      } catch (err) {
          list.innerHTML = `<div style="opacity: 0.5; padding: 1rem;">⚠️ Failed to load staged skills: ${err.message}</div>`;
      }
  }

  async function loadPendingGaps() {
      const list = document.getElementById('pending-gaps-list');
      if (!list) return;
      
      try {
          const res = await fetch('/api/architect/gaps');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { gaps } = await res.json();
          
          if (!gaps || gaps.length === 0) {
              list.innerHTML = `
                <div style="text-align: center; opacity: 0.5; padding: 2rem;">
                  <div style="font-size: 2rem;">✅</div>
                  <p>All clear! No pending gaps.<br>Everything found in repository intake is covered.</p>
                </div>`;
              return;
          }
          
          list.innerHTML = gaps.map(gap => {
              const formattedDate = new Date(gap.ts || Date.now()).toLocaleDateString();
              const sources = Array.isArray(gap.sources) ? gap.sources.join(', ') : (gap.sources || 'Unknown');
              
              return `
                <div class="card glass-card gap-card" style="padding: 1rem; border: 1px solid rgba(245, 158, 11, 0.2); background: rgba(245, 158, 11, 0.02); border-radius: 10px; margin-bottom: 0.75rem;">
                  <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
                    <div style="font-weight: 700; color: #f59e0b; font-size: 0.95rem;">🔍 Gap: "${gap.intent}"</div>
                    <span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; font-size: 0.72rem; padding: 2px 8px; border-radius: 12px;">Hits: ${gap.count || 1}</span>
                  </div>
                  
                  <div style="font-size: 0.82rem; opacity: 0.7; margin-bottom: 0.75rem; line-height: 1.4;">
                    Detected intent triggers capability requirements not present in local skills registry.
                  </div>

                  <!-- Metadata Row -->
                  <div style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.72rem; opacity: 0.5;">
                    <span>📂 Source: ${sources}</span>
                    <span>📅 First Seen: ${formattedDate}</span>
                  </div>
                </div>
              `;
          }).join('');
      } catch (err) {
          list.innerHTML = `<div style="opacity: 0.5; padding: 1rem;">⚠️ Failed to load pending gaps: ${err.message}</div>`;
      }
  }

  async function loadArchitectAuditLog() {
      const rows = document.getElementById('audit-trail-rows');
      if (!rows) return;
      
      try {
          const res = await fetch('/api/architect/audit-log');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { logs } = await res.json();
          
          if (!logs || logs.length === 0) {
              rows.innerHTML = `
                <tr>
                  <td colspan="4" style="padding: 2rem; text-align: center; opacity: 0.5;">
                    No self-modification logs found.
                  </td>
                </tr>`;
              return;
          }
          
          rows.innerHTML = logs.map(log => {
              const formattedTime = new Date(log.ts || Date.now()).toLocaleTimeString() + ' ' + new Date(log.ts || Date.now()).toLocaleDateString();
              
              // Classify event badge colors
              let badgeColor = 'rgba(255, 255, 255, 0.1)';
              let badgeText = '#ffffff';
              if (log.eventType === 'skill_promoted') {
                  badgeColor = 'rgba(16, 185, 129, 0.15)';
                  badgeText = '#10b981';
              } else if (log.eventType === 'gap_detected') {
                  badgeColor = 'rgba(167, 139, 250, 0.15)';
                  badgeText = '#c084fc';
              } else if (log.eventType === 'bot_upgraded') {
                  badgeColor = 'rgba(59, 130, 246, 0.15)';
                  badgeText = '#3b82f6';
              } else if (log.eventType === 'repo_rejected' || log.eventType === 'escalation_raised') {
                  badgeColor = 'rgba(239, 68, 68, 0.15)';
                  badgeText = '#f87171';
              }
              
              return `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                  <td style="padding: 0.75rem 1rem; color: #94a3b8; font-size: 0.8rem; white-space: nowrap;">${formattedTime}</td>
                  <td style="padding: 0.75rem 1rem;">
                    <span style="background: ${badgeColor}; color: ${badgeText}; font-size: 0.72rem; padding: 2px 8px; border-radius: 4px; font-weight: bold; border: 1px solid ${badgeText}33;">
                      ${log.eventType || 'INFO'}
                    </span>
                  </td>
                  <td style="padding: 0.75rem 1rem; font-weight: bold; color: #cbd5e1;">${log.subject || 'system'}</td>
                  <td style="padding: 0.75rem 1rem; color: #cbd5e1; line-height: 1.4;">${log.description || ''}</td>
                </tr>
              `;
          }).join('');
      } catch (err) {
          rows.innerHTML = `
            <tr>
              <td colspan="4" style="padding: 1rem; text-align: center; color: #ef4444;">
                ⚠️ Failed to load audit trail: ${err.message}
              </td>
            </tr>`;
      }
  }

  async function loadBriefing() {
      try {
          const res = await fetch('/api/architect/briefing');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { briefing } = await res.json();
          const dateBadge = document.getElementById('briefing-date-badge');
          const emptyDiv = document.getElementById('briefing-empty');
          const statsDiv = document.getElementById('briefing-stats');

          if (!briefing) {
              if (statsDiv) statsDiv.style.display = 'none';
              if (emptyDiv) emptyDiv.style.display = 'block';
              return;
          }

          if (statsDiv) statsDiv.style.display = 'grid';
          if (emptyDiv) emptyDiv.style.display = 'none';
          if (dateBadge) dateBadge.textContent = briefing.date || 'Today';

          const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
          el('briefing-learned', briefing.learned_count || 0);
          el('briefing-rejected', briefing.rejected_count || 0);
          el('briefing-escalated', briefing.escalated_count || 0);
          el('briefing-upgrades', briefing.upgraded_count || 0);
          el('briefing-gaps', briefing.gaps_remaining || 0);
      } catch (err) {
          console.error('[ARCH-UI] Briefing load error:', err);
      }
  }

  async function loadSelfModelFull() {
      try {
          const res = await fetch('/api/architect/self-model-full');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();

          // ── Render Capabilities ─────────────────────────────────────────
          const capsList = document.getElementById('capabilities-list');
          if (capsList) {
              const caps = data.capabilities || [];
              if (caps.length === 0) {
                  capsList.innerHTML = '<div style="text-align: center; opacity: 0.5; padding: 2rem;"><div style="font-size: 2rem;">🌾</div><p>No capabilities recorded yet.<br>They appear after repository ingestion.</p></div>';
              } else {
                  const grouped = {};
                  caps.forEach(c => {
                      const d = c.domain || 'general';
                      if (!grouped[d]) grouped[d] = [];
                      grouped[d].push(c);
                  });
                  capsList.innerHTML = Object.entries(grouped).map(([domain, items]) => {
                      const domainLabel = domain.charAt(0).toUpperCase() + domain.slice(1);
                      const domainColor = domain === 'auto-discovered' ? '#06b6d4' : domain === 'baseline' ? '#10b981' : '#8b5cf6';
                      return `
                        <div style="margin-bottom: 1rem;">
                          <div style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.5px; color: ${domainColor}; font-weight: 700; margin-bottom: 0.5rem; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.06);">${domainLabel} (${items.length})</div>
                          ${items.map(c => {
                              const conf = Math.round((c.confidence || 0) * 100);
                              const barColor = conf >= 80 ? '#10b981' : conf >= 50 ? '#f59e0b' : '#ef4444';
                              return `
                                <div style="display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 0.82rem;">
                                  <div style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.key.replace('discovered:', '').replace(/_/g, ' ')}</div>
                                  <div style="width: 60px; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden;">
                                    <div style="width: ${conf}%; height: 100%; background: ${barColor}; border-radius: 3px;"></div>
                                  </div>
                                  <span style="font-size: 0.68rem; font-family: monospace; color: ${barColor}; min-width: 32px; text-align: right;">${conf}%</span>
                                </div>
                              `;
                          }).join('')}
                        </div>
                      `;
                  }).join('');
              }
          }

          // ── Render Recent Decisions ────────────────────────────────────
          const decList = document.getElementById('decisions-list');
          if (decList) {
              const decs = data.recentDecisions || [];
              if (decs.length === 0) {
                  decList.innerHTML = '<div style="text-align: center; opacity: 0.5; padding: 2rem;"><div style="font-size: 2rem;">⚖️</div><p>No decisions recorded yet.</p></div>';
              } else {
                  decList.innerHTML = decs.map(d => {
                      const verdictColors = { APPROVE: '#10b981', REJECT: '#ef4444', DISCOVER: '#06b6d4', ESCALATE: '#f59e0b', UPGRADE_APPLIED: '#8b5cf6' };
                      const verdictIcons = { APPROVE: '✅', REJECT: '❌', DISCOVER: '🔬', ESCALATE: '⚠️', UPGRADE_APPLIED: '⚙️' };
                      const color = verdictColors[d.verdict] || '#888';
                      const icon = verdictIcons[d.verdict] || '📌';
                      const time = d.ts ? new Date(d.ts).toLocaleString() : '—';
                      const reason = (d.reason || '').length > 80 ? d.reason.slice(0, 80) + '…' : (d.reason || '—');
                      return `
                        <div style="padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 0.82rem;">
                          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                            <span style="font-weight: 700; color: ${color};">${icon} ${d.verdict}</span>
                            <span style="font-size: 0.68rem; opacity: 0.4; font-family: monospace;">${time}</span>
                          </div>
                          <div style="opacity: 0.65; font-size: 0.78rem; line-height: 1.35;">${reason}</div>
                        </div>
                      `;
                  }).join('');
              }
          }

          // ── Render Pending Escalations ─────────────────────────────────
          const escList = document.getElementById('escalations-list');
          if (escList) {
              const escs = data.pendingEscalations || [];
              if (escs.length === 0) {
                  escList.innerHTML = '<div style="text-align: center; opacity: 0.5; padding: 2rem;"><div style="font-size: 2rem;">✅</div><p>No pending escalations.<br>All clear!</p></div>';
              } else {
                  escList.innerHTML = escs.map(e => {
                      return `
                        <div style="padding: 10px; margin-bottom: 8px; border-radius: 8px; background: rgba(239, 68, 68, 0.04); border: 1px solid rgba(239, 68, 68, 0.15);">
                          <div style="font-weight: 700; color: #f87171; font-size: 0.85rem; margin-bottom: 4px;">🚨 ${e.level || 'MEDIUM'}</div>
                          <div style="font-size: 0.78rem; opacity: 0.7; margin-bottom: 8px; line-height: 1.35;">${e.reason || 'No reason specified'}</div>
                          <button class="btn btn-secondary btn-resolve-esc" data-id="${e.id}" style="padding: 0.3rem 0.6rem; font-size: 0.72rem; border-radius: 6px; border: 1px solid rgba(16, 185, 129, 0.4); color: #34d399; width: 100%;">
                            ✓ Resolve
                          </button>
                        </div>
                      `;
                  }).join('');

                  escList.querySelectorAll('.btn-resolve-esc').forEach(btn => {
                      btn.addEventListener('click', async () => {
                          const id = btn.dataset.id;
                          btn.disabled = true;
                          btn.textContent = 'Resolving...';
                          try {
                              const r = await fetch(`/api/architect/escalation/${id}/resolve`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ resolution: 'Resolved via dashboard' })
                              });
                              if (r.ok) {
                                  loadArchitectData();
                              } else {
                                  alert('Failed to resolve escalation');
                                  btn.disabled = false;
                                  btn.textContent = '✓ Resolve';
                              }
                          } catch (err) {
                              alert('Error: ' + err.message);
                              btn.disabled = false;
                              btn.textContent = '✓ Resolve';
                          }
                      });
                  });
              }
          }

      } catch (err) {
          console.error('[ARCH-UI] Self-model load error:', err);
      }
  }

  async function loadArchitectData() {
      await loadArchitectDiagnostics();
      await loadBriefing();
      await loadSelfModelFull();
      await loadStagedSkills();
      await loadPendingGaps();
      await loadArchitectAuditLog();
  }

  // Bind navigation switch trigger for panels
  navLinks.forEach(link => {
      link.addEventListener('click', () => {
          const targetId = link.getAttribute('data-target');
          if (targetId === 'architect-panel') {
              loadArchitectData();
          } else if (targetId === 'plugins-panel') {
              loadPluginsList();
          }
      });
  });

  // Bind plugins panel refresh button click
  const refreshPluginsBtn = document.getElementById('refresh-plugins-btn');
  if (refreshPluginsBtn) {
      refreshPluginsBtn.addEventListener('click', async () => {
          refreshPluginsBtn.disabled = true;
          refreshPluginsBtn.textContent = '🔄 Loading...';
          await loadPluginsList();
          refreshPluginsBtn.disabled = false;
          refreshPluginsBtn.textContent = 'Refresh';
      });
  }

  // Bind refresh button click
  const refreshBtn = document.getElementById('refresh-diagnostics-btn');
  if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
          refreshBtn.disabled = true;
          refreshBtn.textContent = '🔄 Loading...';
          await loadArchitectData();
          refreshBtn.disabled = false;
          refreshBtn.textContent = '🔄 Refresh';
      });
  }

  // ── Write Audit logic ──
  let selectedPendingChangeId = null;
  let pendingChanges = [];
  let monacoLoaded = false;
  let diffEditorInstance = null;

  async function loadPendingChanges() {
      try {
          const res = await fetch('/api/files/pending');
          const data = await res.json();
          pendingChanges = data.changes || [];
          
          // Update badges
          const badge = document.getElementById('pending-writes-badge');
          const countBadge = document.getElementById('pending-writes-count-badge');
          const bulkActions = document.getElementById('pending-bulk-actions');
          
          if (badge) {
              badge.textContent = pendingChanges.length;
              badge.style.display = pendingChanges.length > 0 ? 'inline-block' : 'none';
          }
          if (countBadge) {
              countBadge.textContent = pendingChanges.length;
          }
          if (bulkActions) {
              bulkActions.style.display = pendingChanges.length > 1 ? 'flex' : 'none';
          }

          renderPendingChangesList();
      } catch (e) {
          console.error('[FILES] Failed to load pending changes:', e);
      }
  }

  function renderPendingChangesList() {
      const listEl = document.getElementById('pending-changes-list');
      if (!listEl) return;

      if (pendingChanges.length === 0) {
          listEl.innerHTML = `
              <div style="text-align: center; opacity: 0.5; padding: 2rem;">
                <div style="font-size: 1.5rem;">📝</div>
                <p style="font-size: 0.85rem;">No pending writes.</p>
              </div>`;
          document.getElementById('diff-viewer-card').style.display = 'none';
          document.getElementById('diff-empty-card').style.display = 'flex';
          selectedPendingChangeId = null;
          return;
      }

      listEl.innerHTML = pendingChanges.map(change => {
          const fullPath = change.file_path || '';
          const fileName = fullPath.substring(Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\')) + 1);
          const isSelected = change.id == selectedPendingChangeId;
          const activeClass = isSelected ? 'active' : '';
          
          return `
              <div class="pending-change-item ${activeClass}" onclick="selectPendingChange(${change.id})" style="padding: 10px; border-radius: 8px; border: 1px solid ${isSelected ? 'var(--accent-primary)' : 'var(--glass-border)'}; background: ${isSelected ? 'rgba(139, 92, 246, 0.15)' : 'rgba(0,0,0,0.1)'}; cursor: pointer; transition: all 0.2s; margin-bottom: 0.5rem;">
                  <div style="font-weight: 600; font-size: 0.88rem; color: ${isSelected ? 'var(--accent-primary)' : 'var(--text-primary)'}; word-break: break-all;">${fileName}</div>
                  <div style="font-size: 0.72rem; opacity: 0.7; margin-top: 4px; word-break: break-all;">${fullPath}</div>
                  <div style="font-size: 0.72rem; opacity: 0.5; margin-top: 2px;">Run: ${change.swarm_run_id}</div>
              </div>
          `;
      }).join('');

      // Auto-select the first pending change if none selected or current no longer exists
      if (selectedPendingChangeId === null || !pendingChanges.some(c => c.id == selectedPendingChangeId)) {
          selectPendingChange(pendingChanges[0].id);
      }
  }

  function selectPendingChange(id) {
      selectedPendingChangeId = id;
      
      const change = pendingChanges.find(c => c.id == id);
      if (!change) {
          document.getElementById('diff-viewer-card').style.display = 'none';
          document.getElementById('diff-empty-card').style.display = 'flex';
          return;
      }

      document.getElementById('diff-empty-card').style.display = 'none';
      document.getElementById('diff-viewer-card').style.display = 'flex';

      const fullPath = change.file_path || '';
      const fileName = fullPath.substring(Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\')) + 1);
      
      document.getElementById('diff-file-name').textContent = fileName;
      document.getElementById('diff-file-path').textContent = fullPath;
      document.getElementById('diff-swarm-id').textContent = `Run ID: ${change.swarm_run_id}`;

      // Initialize Monaco Editor
      const ext = fullPath.substring(fullPath.lastIndexOf('.'));
      initMonacoDiffEditor(change.original_content, change.proposed_content, ext);
      
      // Update highlights in list
      document.querySelectorAll('.pending-change-item').forEach(el => {
          el.style.borderColor = 'var(--glass-border)';
          el.style.background = 'rgba(0,0,0,0.1)';
      });
      // Find the clicked element and highlight it
      const clickedEl = Array.from(document.querySelectorAll('.pending-change-item')).find(el => el.getAttribute('onclick').includes(id));
      if (clickedEl) {
          clickedEl.style.borderColor = 'var(--accent-primary)';
          clickedEl.style.background = 'rgba(139, 92, 246, 0.15)';
      }
  }

  function initMonacoDiffEditor(originalContent, proposedContent, fileExtension) {
      if (!monacoLoaded) {
          if (typeof require === 'undefined') {
              console.error("Monaco loader.js not loaded yet.");
              // Fallback to basic LCS line diff viewer
              createBasicLcsDiff(originalContent, proposedContent);
              return;
          }
          require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' } });
          require(['vs/editor/editor.main'], function () {
              monacoLoaded = true;
              createMonacoDiff(originalContent, proposedContent, fileExtension);
          });
      } else {
          createMonacoDiff(originalContent, proposedContent, fileExtension);
      }
  }

  function createMonacoDiff(originalContent, proposedContent, fileExtension) {
      const container = document.getElementById('monaco-diff-container');
      if (!container) return;

      // Clean up previous instance
      if (diffEditorInstance) {
          diffEditorInstance.dispose();
          diffEditorInstance = null;
      }
      container.innerHTML = '';

      // Determine language based on extension
      let language = 'plaintext';
      if (fileExtension) {
          const ext = fileExtension.toLowerCase().replace(/^\./, '');
          if (['js', 'mjs', 'jsx'].includes(ext)) language = 'javascript';
          else if (['ts', 'tsx'].includes(ext)) language = 'typescript';
          else if (['html', 'htm'].includes(ext)) language = 'html';
          else if (['css', 'scss', 'less'].includes(ext)) language = 'css';
          else if (['json'].includes(ext)) language = 'json';
          else if (['md', 'markdown'].includes(ext)) language = 'markdown';
          else if (['py'].includes(ext)) language = 'python';
          else if (['sh', 'bash'].includes(ext)) language = 'shell';
          else if (['yaml', 'yml'].includes(ext)) language = 'yaml';
      }

      diffEditorInstance = monaco.editor.createDiffEditor(container, {
          theme: 'vs-dark',
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          renderSideBySide: true
      });

      const originalModel = monaco.editor.createModel(originalContent, language);
      const proposedModel = monaco.editor.createModel(proposedContent, language);

      diffEditorInstance.setModel({
          original: originalModel,
          modified: proposedModel
      });
  }

  // Fallback LCS side-by-side diff renderer in case Monaco fails to load
  function createBasicLcsDiff(originalContent, proposedContent) {
      const container = document.getElementById('monaco-diff-container');
      if (!container) return;
      container.innerHTML = '';
      
      const origLines = originalContent.split('\n');
      const propLines = proposedContent.split('\n');
      
      const table = document.createElement('table');
      table.style.width = '100%';
      table.style.height = '100%';
      table.style.borderCollapse = 'collapse';
      table.style.fontFamily = 'monospace';
      table.style.fontSize = '0.82rem';
      
      const maxLength = Math.max(origLines.length, propLines.length);
      let html = '';
      for (let i = 0; i < maxLength; i++) {
          const orig = origLines[i] !== undefined ? origLines[i] : '';
          const prop = propLines[i] !== undefined ? propLines[i] : '';
          
          let origBg = 'transparent';
          let propBg = 'transparent';
          
          if (origLines[i] !== undefined && propLines[i] === undefined) {
              origBg = 'rgba(239, 68, 68, 0.15)';
          } else if (origLines[i] === undefined && propLines[i] !== undefined) {
              propBg = 'rgba(16, 185, 129, 0.15)';
          } else if (orig !== prop) {
              origBg = 'rgba(239, 68, 68, 0.1)';
              propBg = 'rgba(16, 185, 129, 0.1)';
          }
          
          html += `
              <tr style="border-bottom: 1px solid rgba(255,255,255,0.02);">
                  <td style="width: 50%; padding: 2px 8px; background: ${origBg}; white-space: pre-wrap; word-break: break-all; border-right: 1px solid var(--glass-border); color: #f87171;">${orig.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>
                  <td style="width: 50%; padding: 2px 8px; background: ${propBg}; white-space: pre-wrap; word-break: break-all; color: #34d399;">${prop.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>
              </tr>
          `;
      }
      table.innerHTML = html;
      
      const wrapper = document.createElement('div');
      wrapper.style.overflow = 'auto';
      wrapper.style.height = '100%';
      wrapper.appendChild(table);
      container.appendChild(wrapper);
  }

  async function respondToPendingChange(action) {
      if (!selectedPendingChangeId) return;
      
      const changeId = selectedPendingChangeId;
      try {
          const res = await fetch(`/api/files/pending/${changeId}/respond`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action })
          });
          const data = await res.json();
          if (res.ok && data.success) {
              console.log(`[FILES] Change ${changeId} responded with ${action}`);
              await loadPendingChanges();
          } else {
              alert(data.error || 'Failed to submit response');
          }
      } catch (e) {
          console.error('[FILES] Failed to respond to pending change:', e);
      }
  }

  async function respondToAllPendingChanges(action) {
      if (!pendingChanges || pendingChanges.length === 0) return;
      
      const promises = pendingChanges.map(change => {
          return fetch(`/api/files/pending/${change.id}/respond`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action })
          }).catch(e => console.error(`[FILES] Failed to respond to ${change.id}:`, e));
      });
      
      try {
          await Promise.all(promises);
          console.log(`[FILES] Responded to all pending changes with ${action}`);
          await loadPendingChanges();
      } catch (e) {
          console.error('[FILES] Error during bulk response:', e);
      }
  }

  window.selectPendingChange = selectPendingChange;

  // --- Obsolete Swarm History UI Logic removed to resolve duplicate loadSwarmHistory() declarations ---

  // --- Prompt Cache UI Logic ---
  async function loadCacheStats() {
      try {
          const res = await fetch('/api/cache/stats');
          const data = await res.json();
          if (data.success && data.stats) {
              const countEl = document.getElementById('cache-stat-count');
              const hitsEl = document.getElementById('cache-stat-hits');
              if (countEl) countEl.textContent = data.stats.count || 0;
              if (hitsEl) hitsEl.textContent = data.stats.hits || 0;
          }
      } catch (e) {
          console.error('[CACHE] Failed to load cache stats:', e);
      }
  }

  async function clearCache() {
      if (!confirm('Are you sure you want to clear the LLM prompt cache? This may temporarily increase API costs and latency.')) return;
      try {
          const res = await fetch('/api/cache', { method: 'DELETE' });
          if (res.ok) {
              alert('Cache cleared successfully!');
              loadCacheStats();
          } else {
              alert('Failed to clear cache.');
          }
      } catch (e) {
          console.error('[CACHE] Failed to clear cache:', e);
      }
  }

  async function exportDPODataset() {
      const toast = document.getElementById('dpo-export-toast');
      if (toast) {
          toast.style.display = 'none';
          toast.style.color = '#10b981';
      }
      try {
          const res = await fetch('/api/training/export');
          const data = await res.json();
          if (res.ok && data.ok) {
              if (toast) {
                  toast.textContent = `Successfully exported ${data.count} training pairs to: ${data.outputPath}`;
                  toast.style.display = 'block';
              }
          } else {
              if (toast) {
                  toast.textContent = `Export failed: ${data.error || 'Unknown error'}`;
                  toast.style.color = '#ef4444';
                  toast.style.display = 'block';
              }
          }
      } catch (e) {
          console.error('[TRAINING] Export failed:', e);
          if (toast) {
              toast.textContent = `Export failed: ${e.message}`;
              toast.style.color = '#ef4444';
              toast.style.display = 'block';
          }
      }
  }

  // --- Plugin Manager UI Logic ---
  // --- Plugin Manager UI Logic ---
  async function loadPluginsList() {
      const pluginsList = document.getElementById('plugins-list');
      const pluginSelect = document.getElementById('plugin-select');
      if (!pluginsList) return;

      try {
          const res = await fetch('/api/plugins');
          const data = await res.json();
          
          if (data.success && data.plugins && data.plugins.length > 0) {
              // 1. Render active plugins lists
              pluginsList.innerHTML = data.plugins.map(p => {
                  const isActive = p.status === 'active';
                  const isChecked = isActive ? 'checked' : '';
                  const badgeColor = isActive ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
                  const badgeTextColor = isActive ? '#10b981' : '#ef4444';
                  
                  const avgLat = p.stats.invocations > 0 ? `${Math.round(p.stats.avgLatencyMs)}ms` : '—';
                  
                  return `
                      <div class="glass-panel" style="padding: 1.25rem; border-radius: 12px; border: 1px solid var(--glass-border); background: rgba(255, 255, 255, 0.02); display: flex; flex-direction: column; gap: 0.75rem; transition: all 0.2s;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <div>
                                <div style="font-weight: bold; font-size: 1.1rem; color: var(--accent-primary); display: flex; align-items: center; gap: 6px;">
                                    ${p.name} 
                                    <span style="font-size: 0.75rem; color: var(--text-secondary); font-weight: normal; background: rgba(255,255,255,0.05); padding: 1px 6px; border-radius: 4px;">v${p.version}</span>
                                </div>
                                <div style="font-size: 0.88rem; color: var(--text-secondary); margin-top: 4px; line-height: 1.4;">${p.description}</div>
                                ${p.error ? `<div style="color: #ef4444; font-size: 0.8rem; margin-top: 4px;">⚠️ ${p.error}</div>` : ''}
                            </div>
                            
                            <!-- Toggle Switch -->
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <span class="badge" style="background: ${badgeColor}; color: ${badgeTextColor}; padding: 2px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: bold;">
                                    ${p.status.toUpperCase()}
                                </span>
                                <label class="switch-container" style="position: relative; display: inline-block; width: 44px; height: 22px; margin: 0; cursor: pointer;">
                                    <input type="checkbox" ${isChecked} onchange="togglePluginState('${p.id}', this.checked)" style="opacity: 0; width: 0; height: 0;">
                                    <span class="switch-slider" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255,255,255,0.1); border-radius: 34px; transition: .4s; border: 1px solid var(--glass-border);"></span>
                                </label>
                            </div>
                        </div>

                        <!-- Metrics Row -->
                        <div style="display: flex; gap: 1.5rem; padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.05); font-size: 0.78rem; color: var(--text-secondary);">
                            <div>📊 Invocations: <span style="font-weight: bold; color: var(--text-primary);">${p.stats.invocations}</span></div>
                            <div>❌ Errors: <span style="font-weight: bold; color: ${p.stats.errors > 0 ? '#ef4444' : 'var(--text-secondary)'};">${p.stats.errors}</span></div>
                            <div>⏳ Latency: <span style="font-weight: bold; color: var(--text-primary);">${avgLat}</span></div>
                            <div>🛠️ Type: <span style="font-weight: bold; color: #6366f1; text-transform: uppercase;">${p.type || 'system'}</span></div>
                        </div>
                      </div>
                  `;
              }).join('');

              // Add custom styling rules dynamically for the switches if not already present
              if (!document.getElementById('plugin-custom-switch-styles')) {
                  const style = document.createElement('style');
                  style.id = 'plugin-custom-switch-styles';
                  style.textContent = `
                      .switch-container input:checked + .switch-slider {
                          background-color: var(--accent-primary) !important;
                      }
                      .switch-slider:before {
                          position: absolute;
                          content: "";
                          height: 14px;
                          width: 14px;
                          left: 3px;
                          bottom: 3px;
                          background-color: white;
                          transition: .4s;
                          border-radius: 50%;
                      }
                      .switch-container input:checked + .switch-slider:before {
                          transform: translateX(22px);
                      }
                  `;
                  document.head.appendChild(style);
              }

              // 2. Populate sandbox plugin selector dropdown
              if (pluginSelect) {
                  const currentSelected = pluginSelect.value;
                  pluginSelect.innerHTML = '<option value="">-- Choose an active plugin --</option>' + 
                      data.plugins
                          .filter(p => p.status === 'active')
                          .map(p => `<option value="${p.id}" ${p.id === currentSelected ? 'selected' : ''}>${p.name}</option>`)
                          .join('');
              }

          } else {
              pluginsList.innerHTML = `
                  <div style="text-align: center; opacity: 0.5; padding: 2rem;">
                      <div style="font-size: 2rem;">🧩</div>
                      <p>No plugins currently active.</p>
                  </div>
              `;
              if (pluginSelect) {
                  pluginSelect.innerHTML = '<option value="">-- Choose an active plugin --</option>';
              }
          }
      } catch (e) {
          console.error('[PLUGIN] Failed to load plugins:', e);
          pluginsList.innerHTML = `<div style="color: #ef4444; padding: 1rem;">Error loading plugins: ${e.message}</div>`;
      }
  }

  // Define global toggle function
  window.togglePluginState = async function(id, enabled) {
      try {
          const res = await fetch(`/api/plugins/${id}/toggle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled })
          });
          const data = await res.json();
          if (data.success) {
              await loadPluginsList();
          } else {
              alert(data.error || 'Failed to toggle plugin state');
          }
      } catch (err) {
          alert('Error toggling plugin state: ' + err.message);
      }
  };

  // Bind dropdown description hint helper
  const pluginSelectEl = document.getElementById('plugin-select');
  if (pluginSelectEl) {
      pluginSelectEl.addEventListener('change', () => {
          const helpLabel = document.getElementById('args-help-label');
          const argsTextarea = document.getElementById('plugin-test-args');
          if (!helpLabel || !argsTextarea) return;

          const pluginId = pluginSelectEl.value;
          if (pluginId === 'web-search') {
              helpLabel.textContent = 'Use format: {"q": "search term"}';
              argsTextarea.placeholder = '{\n  "q": "what is google antigravity?"\n}';
              argsTextarea.value = '{\n  "q": "what is google antigravity?"\n}';
          } else if (pluginId === 'code-runner') {
              helpLabel.textContent = 'Use format: {"code": "javascript snippet"}';
              argsTextarea.placeholder = '{\n  "code": "const a = 10;\\nconst b = 20;\\nconsole.log(a + b);\\na + b;"\n}';
              argsTextarea.value = '{\n  "code": "const a = 10;\\nconst b = 20;\\nconsole.log(a + b);\\na + b;"\n}';
          } else {
              helpLabel.textContent = 'Provide valid params';
              argsTextarea.placeholder = 'Provide valid JSON arguments...';
              argsTextarea.value = '';
          }
      });
  }

  // Bind sandbox execution form submit
  const testForm = document.getElementById('plugin-test-form');
  if (testForm) {
      testForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const pSelect = document.getElementById('plugin-select');
          const pArgs = document.getElementById('plugin-test-args');
          const runBtn = document.getElementById('run-plugin-test-btn');
          const outPanel = document.getElementById('plugin-test-output-panel');
          const outPre = document.getElementById('plugin-test-output-pre');

          if (!pSelect || !pArgs || !outPre || !outPanel || !runBtn) return;

          const pluginId = pSelect.value;
          if (!pluginId) {
              alert('Please select an active plugin first.');
              return;
          }

          let parsedArgs = {};
          try {
              parsedArgs = JSON.parse(pArgs.value.trim());
          } catch (jsonErr) {
              if (pluginId === 'web-search') {
                  parsedArgs = { q: pArgs.value.trim() };
              } else {
                  alert('Invalid JSON parameters! Please ensure the arguments are in valid JSON format.');
                  return;
              }
          }

          runBtn.disabled = true;
          runBtn.textContent = '⏳ Executing Sandbox...';
          outPanel.style.display = 'block';
          outPre.textContent = 'Executing sandbox container...';

          try {
              const res = await fetch(`/api/plugins/${pluginId}/test`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ params: parsedArgs })
              });
              const data = await res.json();
              if (res.ok && data.success) {
                  outPre.textContent = JSON.stringify(data.result, null, 2);
                  await loadPluginsList();
              } else {
                  outPre.textContent = `Error: ${data.error || 'Failed to execute test'}`;
              }
          } catch (err) {
              outPre.textContent = `Network Exception: ${err.message}`;
          } finally {
              runBtn.disabled = false;
              runBtn.textContent = '⚡ Run Execution Sandbox';
          }
      });
  }

  // Initial load
  loadBotRoles();

  // ── Swarm History Panel ─────────────────────────────────────────────────────
  async function loadSwarmHistory() {
      const tbody = document.getElementById('swarm-history-tbody');
      const empty = document.getElementById('swarm-history-empty');
      const spinner = document.getElementById('swarm-history-spinner');
      if (!tbody) return;

      if (spinner) spinner.style.display = 'block';
      if (empty) empty.style.display = 'none';
      tbody.innerHTML = '';

      try {
          const res = await fetch('/api/history?limit=50');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const runs = data.runs || [];

          if (spinner) spinner.style.display = 'none';

          if (runs.length === 0) {
              if (empty) empty.style.display = 'block';
              loadQualityStats(); // Load stats even if empty
              return;
          }

          tbody.innerHTML = runs.map(run => {
              const started = run.started_at ? new Date(run.started_at).toLocaleString() : '—';
              const duration = run.started_at && run.completed_at
                  ? `${Math.round((run.completed_at - run.started_at) / 1000)}s`
                  : run.status === 'running' ? '⏳ Running' : '—';
              const agentList = (() => {
                  try { return JSON.parse(run.agents_used || '[]').join(', ') || '—'; } catch { return '—'; }
              })();
              const statusColor = { completed: '#10b981', running: '#6366f1', failed: '#ef4444', deleted: '#64748b' }[run.status] || '#94a3b8';
              const promptShort = (run.prompt || 'No prompt').slice(0, 90) + ((run.prompt || '').length > 90 ? '...' : '');
              const summary = (run.result_summary || '').slice(0, 80) + ((run.result_summary || '').length > 80 ? '...' : '');

              // Quality score rendering logic
              const scoreColor = run.quality_score >= 75 ? '#10b981'
                  : run.quality_score >= 45 ? '#f59e0b'
                  : run.quality_score !== null ? '#ef4444' : '#64748b';
              const scoreBadge = run.quality_score !== null
                  ? `<span style="font-weight:700;color:${scoreColor}">${run.quality_score}</span><span style="font-size:0.7em;color:var(--text-secondary)">/100</span>`
                  : `<span style="color:var(--text-secondary);font-size:0.8em;">—</span>`;
              const retryBadge = run.retry_count > 0
                  ? `<span style="font-size:0.68em;color:#f59e0b;margin-left:4px;" title="Retried ${run.retry_count} times">🔄×${run.retry_count}</span>` : '';
              const feedbackDiv = run.quality_feedback
                  ? `<div style="font-size:0.65em;color:var(--text-secondary);margin-top:2px;max-width:150px;white-space:normal;word-break:break-word;" title="${run.quality_feedback.replace(/"/g, '&quot;')}">${run.quality_feedback}</div>`
                  : '';

              return `
                  <tr class="history-row" data-id="${run.id}" style="border-bottom:1px solid var(--glass-border);transition:background 0.2s;" onmouseover="this.style.background='rgba(99,102,241,0.05)'" onmouseout="this.style.background=''">
                    <td style="padding:0.7rem 0.75rem;white-space:nowrap;font-size:0.78em;color:var(--text-secondary);">${started}</td>
                    <td style="padding:0.7rem 0.75rem;max-width:220px;">
                      <div style="font-weight:600;font-size:0.85em;color:var(--text-primary);word-break:break-word;">${promptShort}</div>
                      ${summary ? `<div style="font-size:0.75em;color:var(--text-secondary);margin-top:2px;">${summary}</div>` : ''}
                    </td>
                    <td style="padding:0.7rem 0.75rem;font-size:0.75em;color:var(--text-secondary);">${agentList}</td>
                    <td style="padding:0.7rem 0.75rem;white-space:nowrap;font-size:0.78em;color:var(--text-secondary);">${duration}</td>
                    <td style="padding:0.7rem 0.75rem;vertical-align:middle;">
                      <div>${scoreBadge}${retryBadge}</div>
                      ${feedbackDiv}
                    </td>
                    <td style="padding:0.7rem 0.75rem;">
                      <span style="padding:2px 10px;border-radius:12px;font-size:0.72em;font-weight:600;background:${statusColor}22;color:${statusColor}">${run.status.toUpperCase()}</span>
                    </td>
                    <td style="padding:0.7rem 0.75rem;white-space:nowrap;font-size:0.78em;">
                      ${run.pr_url ? `<a href="${run.pr_url}" target="_blank" style="color:var(--accent-primary);font-weight:600;text-decoration:none;">#${run.pr_number || 'PR'}</a>` : '<span style="opacity:0.4">—</span>'}
                    </td>
                    <td style="padding:0.7rem 0.75rem;white-space:nowrap;">
                      <div style="display:flex;gap:6px;">
                        <button class="btn btn-secondary history-replay-btn" data-id="${run.id}" style="padding:3px 10px;font-size:0.75em;border-radius:6px;" ${run.status === 'deleted' ? 'disabled' : ''}>▶ Replay</button>
                        <button class="btn history-delete-btn" data-id="${run.id}" style="padding:3px 10px;font-size:0.75em;border-radius:6px;background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.2);" ${run.status === 'deleted' ? 'disabled' : ''}>🗑</button>
                      </div>
                    </td>
                  </tr>
              `;
          }).join('');

          // Replay handlers
          tbody.querySelectorAll('.history-replay-btn').forEach(btn => {
              btn.addEventListener('click', async () => {
                  const id = btn.dataset.id;
                  btn.disabled = true; btn.textContent = '⏳';
                  try {
                      const r = await fetch(`/api/history/${id}/replay`, { method: 'POST' });
                      const d = await r.json();
                      if (d.success) {
                          btn.textContent = '✅ Started';
                          setTimeout(() => { btn.textContent = '▶ Replay'; btn.disabled = false; loadSwarmHistory(); }, 3000);
                      } else { btn.textContent = '❌ Failed'; btn.disabled = false; }
                  } catch { btn.textContent = '❌ Error'; btn.disabled = false; }
              });
          });

          // Delete handlers
          tbody.querySelectorAll('.history-delete-btn').forEach(btn => {
              btn.addEventListener('click', async () => {
                  const id = btn.dataset.id;
                  btn.disabled = true; btn.textContent = '...';
                  try {
                      await fetch(`/api/history/${id}`, { method: 'DELETE' });
                      loadSwarmHistory();
                  } catch { btn.textContent = '❌'; btn.disabled = false; }
              });
          });

          // Load quality metrics into the stats bar
          loadQualityStats();

      } catch (e) {
          if (spinner) spinner.style.display = 'none';
          tbody.innerHTML = `<tr><td colspan="7" style="padding:2rem;text-align:center;color:#ef4444;">Failed to load history: ${e.message}</td></tr>`;
      }
  }

  async function loadQualityStats() {
      const avgQualityEl = document.getElementById('stat-avg-quality');
      const totalRetriesEl = document.getElementById('stat-total-retries');
      const activeTopologiesEl = document.getElementById('stat-active-topologies');
      
      try {
          const res = await fetch('/api/history/stats');
          if (!res.ok) return;
          const data = await res.json();
          if (data.success) {
              if (avgQualityEl) {
                  const avg = data.avgQuality;
                  avgQualityEl.textContent = avg !== null ? `${avg}/100` : '—';
                  if (avg !== null) {
                      avgQualityEl.style.color = avg >= 75 ? '#10b981' : avg >= 45 ? '#f59e0b' : '#ef4444';
                  } else {
                      avgQualityEl.style.color = 'var(--text-secondary)';
                  }
              }
              if (totalRetriesEl) {
                  totalRetriesEl.textContent = data.totalRetries || 0;
              }
              if (activeTopologiesEl) {
                  const tops = data.activeTopologies;
                  if (tops && tops !== 'none') {
                      const uniqueTops = [...new Set(tops.split(',').map(t => t.trim()).filter(t => t && t !== 'none'))];
                      activeTopologiesEl.textContent = uniqueTops.length;
                      activeTopologiesEl.title = uniqueTops.join(', ') || 'None';
                  } else {
                      activeTopologiesEl.textContent = '—';
                      activeTopologiesEl.title = '';
                  }
              }
          }
      } catch (e) {
          console.error('[HISTORY] Failed to load quality stats:', e);
      }
  }

  // --- Workspace Management Logic ---
  async function loadWorkspaces() {
      const selectSidebar = document.getElementById('workspace-select');
      const selectMagic = document.getElementById('magic-workspace-select');
      const selectAdvanced = document.getElementById('advanced-workspace-select');
      const tbody = document.getElementById('workspaces-list-tbody');
      
      const updateDropdowns = (workspaces, activePath) => {
          const dropdowns = [selectSidebar, selectMagic, selectAdvanced];
          dropdowns.forEach(select => {
              if (!select) return;
              select.innerHTML = '<option value="">-- Select Workspace --</option>' + 
                  workspaces.map(w => `<option value="${w.path}" ${w.path === activePath ? 'selected' : ''}>${w.name}</option>`).join('');
          });
      };

      try {
          const res = await fetch('/api/workspaces');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const list = data.workspaces || [];
          const active = data.active || '';

          // Sync text fields with active workspace path
          if (active) {
              const dirInputs = ['target-dir', 'magic-target-dir'];
              dirInputs.forEach(id => {
                  const el = document.getElementById(id);
                  if (el) el.value = active;
              });
          }

          updateDropdowns(list, active);

          if (tbody) {
              if (list.length === 0) {
                  tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-secondary);padding:2rem;">No workspaces registered. Use the form above to add one!</td></tr>`;
              } else {
                  tbody.innerHTML = list.map(w => {
                      const isActive = w.path === active;
                      return `
                          <tr style="border-bottom: 1px solid var(--glass-border); transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background=''">
                              <td style="padding: 0.75rem 1rem;">
                                  <div style="font-weight: 600; color: ${isActive ? 'var(--accent-primary)' : 'var(--text-primary)'}; display:flex; align-items:center; gap:8px;">
                                      ${isActive ? '🟢' : '⚪'} ${w.name}
                                  </div>
                              </td>
                              <td style="padding: 0.75rem 1rem; font-family: monospace; font-size: 0.85em; color: var(--text-secondary); word-break: break-all;">${w.path}</td>
                              <td style="padding: 0.75rem 1rem; text-align: right;">
                                  <div style="display:flex; gap:8px; justify-content: flex-end;">
                                      <button class="btn btn-secondary workspace-activate-btn" data-path="${w.path}" style="padding: 4px 10px; font-size: 0.75rem; border-radius: 6px;">Activate</button>
                                      <button class="btn workspace-delete-btn" data-name="${w.name}" style="padding: 4px 10px; font-size: 0.75rem; border-radius: 6px; background: rgba(239,68,68,0.1); color: #f87171; border: 1px solid rgba(239,68,68,0.2);">Delete</button>
                                  </div>
                              </td>
                          </tr>
                      `;
                  }).join('');

                  // Attach action listeners
                  tbody.querySelectorAll('.workspace-activate-btn').forEach(btn => {
                      btn.addEventListener('click', () => selectWorkspace(btn.dataset.path));
                  });
                  tbody.querySelectorAll('.workspace-delete-btn').forEach(btn => {
                      btn.addEventListener('click', () => deleteWorkspace(btn.dataset.name));
                  });
              }
          }
      } catch (err) {
          console.error('[WORKSPACES] Failed to load workspaces:', err);
      }
  }

  async function selectWorkspace(path) {
      try {
          const res = await fetch('/api/workspaces/active', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path })
          });
          if (res.ok) {
              loadWorkspaces();
              addTimelineItem("Workspace Changed", `Active directory switched to: ${path}`, "📂");
          }
      } catch (err) {
          console.error('[WORKSPACES] Failed to set active workspace:', err);
      }
  }

  async function deleteWorkspace(name) {
      if (!confirm(`Are you sure you want to delete workspace "${name}"?`)) return;
      try {
          const res = await fetch(`/api/workspaces/${encodeURIComponent(name)}`, {
              method: 'DELETE'
          });
          if (res.ok) {
              loadWorkspaces();
              addTimelineItem("Workspace Deleted", `Removed workspace: ${name}`, "🗑️");
          } else {
              const data = await res.json();
              alert(`Error: ${data.error || 'Failed to delete workspace'}`);
          }
      } catch (err) {
          console.error('[WORKSPACES] Failed to delete workspace:', err);
      }
  }

  // Bind dropdown change handlers
  ['workspace-select', 'magic-workspace-select', 'advanced-workspace-select'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
          el.addEventListener('change', (e) => {
              if (e.target.value) selectWorkspace(e.target.value);
          });
      }
  });

  // Bind create form submit
  const wsForm = document.getElementById('workspace-create-form');
  if (wsForm) {
      wsForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const nameInput = document.getElementById('workspace-name');
          const pathInput = document.getElementById('workspace-path');
          if (!nameInput || !pathInput) return;

          const name = nameInput.value.trim();
          const path = pathInput.value.trim();

          if (!name || !path) {
              alert('Please enter both name and path.');
              return;
          }

          try {
              const res = await fetch('/api/workspaces', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name, path })
              });
              const data = await res.json();
              if (res.ok) {
                  nameInput.value = '';
                  pathInput.value = '';
                  loadWorkspaces();
                  addTimelineItem("Workspace Added", `Registered workspace: ${name} (${path})`, "📂");
              } else {
                  alert(`Error: ${data.error || 'Failed to register workspace'}`);
              }
          } catch (err) {
              console.error('[WORKSPACES] Failed to create workspace:', err);
          }
      });
  }

  // Bind refresh button
  document.getElementById('refresh-workspaces-btn')?.addEventListener('click', loadWorkspaces);

  // Bind workspace browse button
  const wsBrowseBtn = document.getElementById('browse-workspace-btn');
  if (wsBrowseBtn) {
      wsBrowseBtn.addEventListener('click', async () => {
          wsBrowseBtn.disabled = true;
          const originalText = wsBrowseBtn.textContent;
          wsBrowseBtn.textContent = 'Opening...';
          try {
              const res = await fetch('/api/select-folder');
              const data = await res.json();
              if (data.path) {
                  document.getElementById('workspace-path').value = data.path;
              }
          } catch (err) {
              console.error("Failed to open folder picker", err);
          } finally {
              wsBrowseBtn.disabled = false;
              wsBrowseBtn.textContent = originalText;
          }
      });
  }

  // Trigger initial session check & dashboard initialization
  checkSessionStatus();

});





