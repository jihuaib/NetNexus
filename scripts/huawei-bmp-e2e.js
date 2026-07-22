const fs = require('fs');
const path = require('path');
const { HuaweiBmpLiveScenario } = require('./e2e-support/huawei-bmp-live-suite');
const { HUAWEI_BMP_SCENARIOS, getScenario } = require('./e2e-support/huawei-bmp-scenarios');

function selectedScenarios() {
    const configured = String(process.env.NETNEXUS_HUAWEI_SCENARIOS || 'all')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    if (configured.includes('all')) return HUAWEI_BMP_SCENARIOS;
    return configured.map(getScenario);
}

function markdownSummary(summary) {
    const lines = [
        '# Huawei BMP live E2E report',
        '',
        `Started: ${summary.startedAt}`,
        `Finished: ${summary.finishedAt}`,
        '',
        '| Scenario | Result | Code issues | Device limitations | Setup issues | Restored |',
        '| --- | --- | ---: | ---: | ---: | --- |'
    ];
    for (const result of summary.results) {
        lines.push(
            `| ${result.scenario} | ${result.result} | ${result.codeIssues.length} | ` +
                `${result.deviceLimitations.length} | ${result.setupIssues.length} | ${result.restored ? 'yes' : 'no'} |`
        );
    }
    const appendDetails = (title, selector) => {
        const details = summary.results.flatMap(result =>
            selector(result).map(item => ({ scenario: result.scenario, ...item }))
        );
        lines.push('', `## ${title}`, '');
        if (!details.length) {
            lines.push('None.');
            return;
        }
        details.forEach(item => lines.push(`- ${item.scenario}: ${item.detail || JSON.stringify(item)}`));
    };
    appendDetails('Code issues', result => result.codeIssues);
    appendDetails('Device limitations', result => result.deviceLimitations);
    appendDetails('Setup issues', result => result.setupIssues);
    return `${lines.join('\n')}\n`;
}

async function runScenario(definition) {
    const live = new HuaweiBmpLiveScenario({ scenario: definition });
    let thrownError = null;
    try {
        await live.startCollector();
        await live.apply({ trialSeconds: Number(process.env.NETNEXUS_HUAWEI_TRIAL_SECONDS || 900) });
        await live.waitForData({ timeoutMs: Number(process.env.NETNEXUS_HUAWEI_SCENARIO_TIMEOUT_MS || 120000) });
        await live.collectFinal();
    } catch (error) {
        thrownError = error;
        live.report.setupIssues.push({ detail: error.message, stack: error.stack });
    } finally {
        try {
            await live.cleanup();
        } catch (error) {
            thrownError ||= error;
        }
    }
    const reportPath = live.writeReport();
    const restored = live.report.restore?.length === 2 && live.report.restore.every(result => result.verified);
    const result =
        thrownError || live.report.setupIssues.length || !restored
            ? 'setup-error'
            : live.report.codeIssues.length
              ? 'code-issue'
              : 'passed';
    return {
        scenario: definition.key,
        name: definition.name,
        result,
        reportPath,
        codeIssues: live.report.codeIssues,
        deviceLimitations: live.report.deviceLimitations,
        setupIssues: live.report.setupIssues,
        restored
    };
}

async function main() {
    const scenarios = selectedScenarios();
    const artifactDirectory = path.resolve(process.env.NETNEXUS_HUAWEI_ARTIFACT_DIR || '.huawei-bmp-e2e/live-20260721');
    const summary = {
        schemaVersion: 1,
        startedAt: new Date().toISOString(),
        scenarios: scenarios.map(scenario => scenario.key),
        results: []
    };
    for (const scenario of scenarios) {
        process.stdout.write(`\n[Huawei BMP E2E] ${scenario.key}: ${scenario.name}\n`);
        const result = await runScenario(scenario);
        summary.results.push(result);
        process.stdout.write(
            `${JSON.stringify(
                {
                    scenario: result.scenario,
                    result: result.result,
                    codeIssues: result.codeIssues.length,
                    deviceLimitations: result.deviceLimitations.length,
                    setupIssues: result.setupIssues.length,
                    restored: result.restored,
                    reportPath: result.reportPath
                },
                null,
                2
            )}\n`
        );
    }
    summary.finishedAt = new Date().toISOString();
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const jsonPath = path.join(artifactDirectory, 'suite-summary.json');
    const markdownPath = path.join(artifactDirectory, 'suite-summary.md');
    fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(markdownPath, markdownSummary(summary), { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`\nHuawei BMP E2E summary: ${jsonPath}\n`);
    if (summary.results.some(result => result.result !== 'passed')) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`Huawei BMP E2E suite failed: ${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    markdownSummary,
    runScenario,
    selectedScenarios
};
