let ioInstance = null;

module.exports = {
    setIO: (io) => { ioInstance = io; },
    getIO: () => {
        if (!ioInstance) {
            console.warn('[SocketSingleton] getIO() called before setIO()');
        }
        return ioInstance;
    }
};
