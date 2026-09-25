const jwt = require('jsonwebtoken');

module.exports = function authenticateJWT(req, res, next) {
    // Authentication disabled: grant direct access as admin
    req.user = { id: 1, username: 'admin' };
    return next();
};

