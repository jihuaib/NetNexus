const { parentPort } = require('worker_threads');

parentPort.on('message', templateData => {
    try {
        const { template, placeholder, start, end } = templateData;

        const startNum = parseInt(start);
        const endNum = parseInt(end);

        const results = [];
        for (let i = startNum; i <= endNum; i++) {
            const line = template.replaceAll(placeholder, i);
            results.push(line);
        }

        parentPort.postMessage({ status: 'success', data: results });
    } catch (err) {
        parentPort.postMessage({ status: 'error', msg: err.message });
    }
});
