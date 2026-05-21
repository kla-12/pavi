const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

let mainWindow;
let serverProcess;
const PORT = 3000;

function checkServerReady(callback) {
    const client = new net.Socket();
    client.connect({ port: PORT, host: '127.0.0.1' }, () => {
        client.destroy();
        callback(true);
    });
    client.on('error', () => {
        client.destroy();
        callback(false);
    });
}

function startServer() {
    console.log('[ELECTRON] Spawning background server...');
    const serverPath = path.join(__dirname, 'server.js');
    
    serverProcess = spawn('node', [serverPath], {
        cwd: __dirname,
        env: { ...process.env, PORT: PORT },
        stdio: 'inherit'
    });

    serverProcess.on('error', (err) => {
        console.error('[ELECTRON] Failed to start background server:', err);
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        title: 'Pavi - Antigravity Agentic Dashboard',
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        },
        autoHideMenuBar: true,
        backgroundColor: '#0a0b0d'
    });

    const loadUrl = () => {
        mainWindow.loadURL(`http://localhost:${PORT}`).catch(() => {
            console.log('[ELECTRON] Connection failed, retrying in 1s...');
            setTimeout(loadUrl, 1000);
        });
    };

    // Show a loading screen or placeholder if server not ready
    checkServerReady((ready) => {
        if (ready) {
            loadUrl();
        } else {
            startServer();
            setTimeout(loadUrl, 1500);
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    console.log('[ELECTRON] All windows closed. Cleaning up...');
    if (serverProcess) {
        console.log('[ELECTRON] Terminating background server process...');
        serverProcess.kill('SIGINT');
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

process.on('exit', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
});
