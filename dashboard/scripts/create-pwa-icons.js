const fs = require('fs');
const path = require('path');

// 1x1 transparent pixel png
const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const buffer = Buffer.from(base64Png, 'base64');

const pwaDir = path.join(__dirname, '..', 'pwa');
if (!fs.existsSync(pwaDir)) {
    fs.mkdirSync(pwaDir, { recursive: true });
}

const files = [
    'icon-192.png',
    'icon-512.png',
    'icon-512-maskable.png',
    'screenshot-mobile.png',
    'shortcut-task.png',
    'shortcut-history.png',
    'badge-72.png'
];

files.forEach(f => {
    fs.writeFileSync(path.join(pwaDir, f), buffer);
});
console.log('Successfully created all PWA placeholder image files!');
