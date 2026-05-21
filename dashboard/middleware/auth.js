const jwt = require('jsonwebtoken');

module.exports = function authenticateJWT(req, res, next) {
    // 1. Bypass public paths
    const publicPaths = [
        '/api/auth/login',
        '/api/auth/register',
        '/api/auth/status',
        '/api/auth/setup-required',
        '/api/auth/mobile-pin',
        '/api/health',
        '/api/ngrok-url',
        '/api/local-ip',
        '/',
        '/mobile-login'
    ];

    // CRITICAL: Allow socket.io handshake through — its own token auth happens in server.js
    // Without this, the HTTP polling upgrade returns 401 and the mobile page never connects.
    if (req.path.startsWith('/socket.io/')) {
        return next();
    }

    if (publicPaths.includes(req.path) || req.path.startsWith('/api/auth/register') || req.path.startsWith('/api/auth/login') || req.path.startsWith('/api/auth/status') || req.path.startsWith('/api/auth/setup-required') || req.path.startsWith('/api/auth/mobile-pin') || req.path.startsWith('/api/ngrok-url') || req.path.startsWith('/api/local-ip')) {
        return next();
    }

    // Special verification and redirect for mobile PWA remote access
    if (req.path === '/mobile' || req.path === '/mobile.html') {
        if (process.env.SKIP_AUTH_ON_LOCALHOST === 'true') {
            const ip = req.ip || req.connection?.remoteAddress || '';
            if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
                return next();
            }
        }

        const token = req.cookies.pavi_session;
        if (!token) {
            return res.redirect('/mobile-login');
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || '4f5e7b23c56a12b4e8c9d0e1f2a3b4c5d6e7f8');
            req.user = decoded;
            return next();
        } catch (err) {
            res.clearCookie('pavi_session', {
                httpOnly: true,
                secure: false,
                sameSite: 'lax'
            });
            return res.redirect('/mobile-login');
        }
    }

    // Bypass standard frontend static assets (CSS, JS, assets) for simple local execution
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        return next();
    }

    // 2. Localhost Auth Bypass (Opt-in)
    if (process.env.SKIP_AUTH_ON_LOCALHOST === 'true') {
        const ip = req.ip || req.connection?.remoteAddress || '';
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
            return next();
        }
    }

    // 3. JWT Token check from httpOnly cookie
    const token = req.cookies.pavi_session;
    if (!token) {
        return res.status(401).json({ error: 'Authentication required. Please login.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || '4f5e7b23c56a12b4e8c9d0e1f2a3b4c5d6e7f8');
        req.user = decoded;
        next();
    } catch (err) {
        console.warn(`[AUTH] Session validation failed from ${req.ip}: ${err.message}`);
        
        // Clear invalid/expired cookie
        res.clearCookie('pavi_session', {
            httpOnly: true,
            secure: false,
            sameSite: 'lax'
        });
        
        return res.status(401).json({ error: 'Session expired or invalid. Please login again.' });
    }
};

