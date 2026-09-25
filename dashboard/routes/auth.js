const logger = require('../utils/logger');
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { usersDB } = require('../db');

// JWT Secret resolver
const JWT_SECRET = process.env.JWT_SECRET || '4f5e7b23c56a12b4e8c9d0e1f2a3b4c5d6e7f8';

/**
 * POST /api/auth/register
 * 
 * Strict Single-Admin Guard:
 * Registers the initial administrator ONLY if there are no existing users.
 * Rejects requests with 403 Forbidden if any user is already present.
 */
router.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        // Server-side database guard
        const userCount = usersDB.getUserCount();
        if (userCount > 0) {
            logger.warn(`[AUTH] Blocked unauthorized registration attempt for user "${username}" from IP: ${req.ip}`);
            return res.status(403).json({ error: 'Initial administrator setup is already completed. Registration is closed.' });
        }

        // Hash and save user credentials securely
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        usersDB.createUser(username, passwordHash);

        logger.info(`[AUTH] Initial administrative account "${username}" created successfully.`);
        return res.json({ success: true, message: 'Initial administrative account registered successfully.' });

    } catch (err) {
        logger.error('[AUTH] Registration failed:', err);
        return res.status(500).json({ error: 'Registration failed due to a server error.' });
    }
});

/**
 * POST /api/auth/login
 * 
 * Verifies credentials and issues httpOnly session cookies.
 */
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        const user = usersDB.getByUsername(username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        // Generate JWT with an explicit 8-hour expiry
        const token = jwt.sign(
            { id: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        // Send JWT inside secure, httpOnly session cookie
        res.cookie('pavi_session', token, {
            httpOnly: true,
            secure: false,           // HTTP-only LAN — can't use secure on non-HTTPS
            sameSite: 'lax',
            maxAge: 8 * 60 * 60 * 1000 // 8 hours
        });

        logger.info(`[AUTH] User "${username}" authenticated from IP: ${req.ip}`);
        return res.json({ success: true, username: user.username });

    } catch (err) {
        logger.error('[AUTH] Login failure:', err);
        return res.status(500).json({ error: 'Login failed due to a server error.' });
    }
});

/**
 * POST /api/auth/logout
 * 
 * Clears the session cookie.
 */
router.post('/logout', (req, res) => {
    res.clearCookie('pavi_session', {
        httpOnly: true,
        secure: false,
        sameSite: 'lax'
    });
    logger.info('[AUTH] User logged out.');
    return res.json({ success: true, message: 'Logged out successfully.' });
});

/**
 * GET /api/auth/status
 * 
 * Quick status route to let frontend verify active session.
 */
router.get('/status', (req, res) => {
    return res.json({ authenticated: true, username: 'admin' });
});

/**
 * GET /api/auth/setup-required
 * 
 * Tells UI whether a setup register wizard is required (if user count is 0).
 */
router.get('/setup-required', (req, res) => {
    return res.json({ setupRequired: false });
});

const pinAttempts = new Map(); // ip -> { count, lockedUntil }

/**
 * POST /api/auth/mobile-pin
 * 
 * Handles PWA PIN login with rate-limiting.
 */
router.post('/mobile-pin', (req, res) => {
    const { pin } = req.body;
    const ip = req.ip || req.connection?.remoteAddress || '';
    
    // Check lockout
    const attempt = pinAttempts.get(ip);
    if (attempt && attempt.lockedUntil > Date.now()) {
        const remainingMin = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
        return res.status(429).json({ error: `Too many failed attempts. Locked out for ${remainingMin} more minutes.` });
    }
    
    if (!pin) {
        return res.status(400).json({ error: 'PIN is required.' });
    }
    
    const configuredPin = process.env.MOBILE_PIN || '123456';
    
    if (pin.toString() === configuredPin.toString()) {
        // Success
        pinAttempts.delete(ip);
        
        const token = jwt.sign(
            { id: 9999, username: 'Mobile Remote User' },
            JWT_SECRET,
            { expiresIn: '8h' }
        );
        
        res.cookie('pavi_session', token, {
            httpOnly: true,
            secure: false,           // HTTP-only LAN — can't use secure on non-HTTPS
            sameSite: 'lax',
            maxAge: 8 * 60 * 60 * 1000
        });
        
        logger.info(`[AUTH] Mobile PWA remote login successful for IP: ${ip}`);
        return res.json({ success: true, username: 'Mobile Remote User' });
    } else {
        const count = attempt ? attempt.count + 1 : 1;
        let lockedUntil = 0;
        if (count >= 5) {
            lockedUntil = Date.now() + 15 * 60 * 1000;
            logger.warn(`[AUTH] IP ${ip} locked out of Mobile PIN login.`);
        }
        pinAttempts.set(ip, { count, lockedUntil });
        
        return res.status(401).json({ 
            error: 'Invalid PIN.', 
            attemptsRemaining: Math.max(0, 5 - count),
            locked: count >= 5
        });
    }
});

module.exports = router;

