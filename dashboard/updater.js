const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const REPO_URL = 'https://github.com/ruflo-main'; // Replace with actual URL
const POLL_INTERVAL = 1000 * 60 * 60; // 1 hour

function checkForUpdates() {
    console.log('[UPDATER] Checking for updates...');
    
    exec('git fetch origin main', { cwd: PROJECT_ROOT }, (error, stdout, stderr) => {
        if (error) {
            console.warn('[UPDATER] Fetch failed:', error.message);
            return;
        }

        exec('git rev-parse HEAD', { cwd: PROJECT_ROOT }, (err, localHead) => {
            if (err) return;

            exec('git rev-parse origin/main', { cwd: PROJECT_ROOT }, (err, remoteHead) => {
                if (err) return;

                if (localHead.trim() !== remoteHead.trim()) {
                    console.log('[UPDATER] Update found! Pulling latest changes...');
                    
                    exec('git pull origin main', { cwd: PROJECT_ROOT }, (err, pullOut) => {
                        if (err) {
                            console.error('[UPDATER] Failed to pull updates:', err.message);
                            return;
                        }
                        
                        console.log('[UPDATER] Updates pulled successfully. Restarting application...');
                        restartApp();
                    });
                } else {
                    console.log('[UPDATER] Application is up to date.');
                }
            });
        });
    });
}

function restartApp() {
    // We assume PM2 or a similar process manager will restart us if we exit,
    // or if running in Electron, we tell Electron to relaunch.
    
    try {
        if (process.send) {
            // If running via a manager that supports IPC (like PM2)
            process.send('restart');
        } else if (process.versions.electron) {
            // Electron specific restart
            const { app } = require('electron');
            app.relaunch();
            app.exit(0);
        } else {
            console.log('[UPDATER] Exiting process to allow manager to restart...');
            process.exit(0);
        }
    } catch (e) {
        console.error('[UPDATER] Restart failed:', e.message);
        process.exit(0);
    }
}

function startAutoUpdater() {
    // Check if git is available and it's a git repo
    const gitDir = path.join(PROJECT_ROOT, '.git');
    if (fs.existsSync(gitDir)) {
        console.log('[UPDATER] Auto-updater initialized.');
        setInterval(checkForUpdates, POLL_INTERVAL);
        
        // Initial check 5 minutes after startup
        setTimeout(checkForUpdates, 1000 * 60 * 5);
    } else {
        console.warn('[UPDATER] Not a git repository, auto-updater disabled.');
    }
}

module.exports = {
    startAutoUpdater,
    checkForUpdates
};
