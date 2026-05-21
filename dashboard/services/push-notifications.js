const webpush = require('web-push');
const { pushSubscriptionsDB } = require('../db');

// Allow custom or default VAPID configuration
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:admin@pavi.local';
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (vapidPublicKey && vapidPrivateKey) {
    webpush.setVapidDetails(
        vapidEmail.startsWith('mailto:') ? vapidEmail : `mailto:${vapidEmail}`,
        vapidPublicKey,
        vapidPrivateKey
    );
} else {
    console.warn('[Push Service] VAPID keys not configured in .env. Real push notifications will not be sent.');
}

async function sendNotification(subscription, payload) {
    if (!vapidPublicKey || !vapidPrivateKey) return;
    
    // Structure expected by web-push package
    const subObj = {
        endpoint: subscription.endpoint,
        keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth
        }
    };
    
    try {
        await webpush.sendNotification(subObj, JSON.stringify(payload));
    } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
            // Subscription expired or invalid — remove it
            console.log(`[Push Service] Removing expired subscription for endpoint: ${subscription.endpoint}`);
            pushSubscriptionsDB.remove(subscription.endpoint);
        } else {
            console.error('[Push Service] Notification send error:', e.message);
        }
    }
}

async function broadcastNotification(payload) {
    try {
        const subs = pushSubscriptionsDB.getAll();
        const promises = subs.map(sub => sendNotification(sub, payload));
        await Promise.allSettled(promises);
    } catch (err) {
        console.error('[Push Service] Broadcast error:', err.message);
    }
}

module.exports = {
    sendNotification,
    broadcastNotification
};
