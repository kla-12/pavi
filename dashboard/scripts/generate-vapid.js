const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const keys = webpush.generateVAPIDKeys();

console.log('--- Generated VAPID Keys ---');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('----------------------------');

// Automatically append or update in .env if running locally
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    let updated = false;

    if (!envContent.includes('VAPID_PUBLIC_KEY')) {
        envContent += `\nVAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nVAPID_EMAIL=admin@pavi.local\nMOBILE_PIN=123456\n`;
        updated = true;
    }

    if (updated) {
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('Appended VAPID keys and default MOBILE_PIN (123456) to .env file!');
    }
}
