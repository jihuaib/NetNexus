function createTrustedBmpEvent(app) {
    const sender = app.primaryWebContents || {
        mainFrame: { url: 'http://127.0.0.1:3000/#/bmp' }
    };
    app.primaryWebContents = sender;
    app.appIsPackaged = false;
    app.browserWindow = {
        fromWebContents: value => (value === sender ? { isDestroyed: () => false } : null)
    };
    return { sender, senderFrame: sender.mainFrame };
}

module.exports = { createTrustedBmpEvent };
