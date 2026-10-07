const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const yaml = require('js-yaml');
const { generateReleaseNotes, loadReleaseNotes, verifyReleaseNotes } = require('../../scripts/generate-release-notes');
const { configureReleaseNotes } = require('../../scripts/verify-packaging-runtime');
const {
    createGiteeRelease,
    getBuildCommand,
    isCurrentInstallationAsset,
    publishGitHubRelease,
    rebuildRenderer,
    verifyGithubPrerequisites
} = require('../../scripts/release');

const projectRoot = path.join(__dirname, '..', '..');
const fixtureNotes = {
    summary: '发布摘要保留 `原样`、$() 和双引号 "。',
    sections: [
        { title: 'BGP', items: ['新增路由能力。', '修复报文解析。'] },
        { title: '设置', items: ['显示每个版本的更新日志。'] }
    ]
};
const expectedMarkdown =
    '发布摘要保留 `原样`、$() 和双引号 "。\n\n' +
    '## BGP\n\n- 新增路由能力。\n- 修复报文解析。\n\n' +
    '## 设置\n\n- 显示每个版本的更新日志。\n';

function writeFixture(root, notes = fixtureNotes) {
    fs.mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
            version: '1.2.3',
            build: { publish: { provider: 'github', owner: 'fixture', repo: 'NetNexus' } }
        })
    );
    fs.writeFileSync(path.join(root, 'src', 'data', 'releaseNotes.json'), JSON.stringify({ '1.2.3': notes }));
}

function testGenerator(root) {
    writeFixture(root);
    assert.equal(generateReleaseNotes({ projectRoot: root }), expectedMarkdown);
    assert.equal(generateReleaseNotes({ projectRoot: root, tag: 'v1.2.3' }), expectedMarkdown);
    assert.throws(() => generateReleaseNotes({ projectRoot: root, tag: 'v1.2.4' }), /does not match package version/);
    assert.throws(() => generateReleaseNotes({ projectRoot: root, tag: '1.2.3' }), /does not match package version/);

    const invalidNotes = [
        null,
        [],
        {},
        { ...fixtureNotes, summary: '' },
        { ...fixtureNotes, summary: ' leading space' },
        { ...fixtureNotes, summary: 'two\nlines' },
        { ...fixtureNotes, sections: [] },
        { ...fixtureNotes, sections: [null] },
        { ...fixtureNotes, sections: [{ title: '', items: ['Item'] }] },
        { ...fixtureNotes, sections: [{ title: 'BGP\nBMP', items: ['Item'] }] },
        { ...fixtureNotes, sections: [{ title: 'BGP', items: [] }] },
        { ...fixtureNotes, sections: [{ title: 'BGP', items: [5] }] },
        { ...fixtureNotes, sections: [{ title: 'BGP', items: [' '] }] },
        { ...fixtureNotes, sections: [{ title: 'BGP', items: ['Item\nsecond item'] }] },
        { ...fixtureNotes, sections: [{ title: 'BGP', items: ['Item '] }] },
        { ...fixtureNotes, sections: [fixtureNotes.sections[0], fixtureNotes.sections[0]] }
    ];
    for (const notes of invalidNotes) {
        writeFixture(root, notes);
        assert.throws(() => generateReleaseNotes({ projectRoot: root }), /Release notes/);
    }
    const notesPath = path.join(root, 'src', 'data', 'releaseNotes.json');
    fs.writeFileSync(notesPath, JSON.stringify({ '1.2.2': fixtureNotes }));
    assert.throws(() => generateReleaseNotes({ projectRoot: root }), /missing for version 1\.2\.3/);
    fs.writeFileSync(notesPath, '{');
    assert.throws(() => generateReleaseNotes({ projectRoot: root }), SyntaxError);
    fs.rmSync(notesPath);
    assert.throws(() => generateReleaseNotes({ projectRoot: root }), /ENOENT/);
    writeFixture(root);
    verifyReleaseNotes(expectedMarkdown, expectedMarkdown.replace(/\n$/, ''));
    verifyReleaseNotes(expectedMarkdown, `${expectedMarkdown}\n`);
    assert.throws(() => verifyReleaseNotes(expectedMarkdown, expectedMarkdown.replace('BGP', 'BMP')), /differ/);
    assert.throws(() => verifyReleaseNotes(expectedMarkdown, expectedMarkdown.replace(/\n/g, '\r\n')), /differ/);
}

function testCli(root) {
    const generatorPath = path.join(root, 'scripts', 'generate-release-notes.js');
    fs.copyFileSync(path.join(projectRoot, 'scripts', 'generate-release-notes.js'), generatorPath);
    const run = args =>
        spawnSync(process.execPath, [generatorPath, ...args], {
            encoding: 'utf8',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        });
    assert.equal(run([]).stdout, expectedMarkdown);
    const outputPath = path.join(root, 'notes with spaces.md');
    assert.equal(run(['--tag', 'v1.2.3', '--output', outputPath]).status, 0);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), expectedMarkdown);
    assert.equal(run(['--verify', outputPath]).status, 0);
    fs.writeFileSync(outputPath, 'Different release body\n');
    const mismatch = run(['--verify', outputPath]);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /differ/);
    for (const args of [['--tag', 'v1.2.4'], ['--tag'], ['--output'], ['--unknown']]) {
        assert.notEqual(run(args).status, 0);
    }
    const notesPath = path.join(root, 'src', 'data', 'releaseNotes.json');
    for (const invalidJson of ['{', JSON.stringify({ '1.2.2': fixtureNotes })]) {
        fs.writeFileSync(notesPath, invalidJson);
        const failed = run(['--tag', 'v1.2.3']);
        assert.notEqual(failed.status, 0);
        assert.equal(failed.stdout, '', 'invalid release data must not produce publishable notes');
    }
    fs.rmSync(notesPath);
    assert.notEqual(run([]).status, 0);
    writeFixture(root);
}

function testPackagingHook(root) {
    const createContext = () => ({
        targets: [{ name: 'nsis' }],
        packager: {
            projectDir: root,
            appInfo: { version: '1.2.3' },
            packagerOptions: { publish: 'never' },
            config: { releaseInfo: { releaseName: 'Keep name', releaseNotes: 'Old notes' } },
            platformSpecificBuildOptions: { releaseInfo: { releaseNotes: 'Platform override' } }
        }
    });
    const context = createContext();
    configureReleaseNotes(context, { env: {} });
    assert.equal(context.packager.config.releaseInfo.releaseName, 'Keep name');
    assert.equal(context.packager.config.releaseInfo.releaseNotes, expectedMarkdown);
    assert.equal(context.packager.platformSpecificBuildOptions.releaseInfo.releaseNotes, expectedMarkdown);
    context.packager.appInfo.version = '1.2.4';
    assert.throws(() => configureReleaseNotes(context, { env: {} }), /Packaged version.*does not match/);
    assert.throws(() => configureReleaseNotes(createContext(), { env: { RELEASE_TAG: 'v1.2.4' } }), /does not match/);
    for (const policy of ['always', 'onTagOrDraft', 'onTag']) {
        const publishing = createContext();
        publishing.packager.packagerOptions.publish = policy;
        assert.throws(
            () => configureReleaseNotes(publishing, { env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' } }),
            /Direct electron-builder publishing/
        );
    }
    const inferred = createContext();
    delete inferred.packager.packagerOptions.publish;
    assert.throws(
        () => configureReleaseNotes(inferred, { env: { CI: 'true', GH_TOKEN: 'fixture-token' } }),
        /Direct electron-builder publishing/
    );
    assert.doesNotThrow(() => configureReleaseNotes(inferred, { env: {} }));
    assert.throws(() => configureReleaseNotes(inferred, { env: { CI: 'true' } }), /Direct electron-builder publishing/);
    inferred.packager.packagerOptions.publish = ['always', 'never'];
    assert.throws(() => configureReleaseNotes(inferred, { env: {} }), /Invalid electron-builder publish policy/);
    inferred.packager.packagerOptions.publish = 'onTag';
    assert.doesNotThrow(() => configureReleaseNotes(inferred, { env: {} }));
    inferred.targets = [{ name: 'dir' }];
    inferred.packager.packagerOptions.publish = 'always';
    assert.doesNotThrow(() => configureReleaseNotes(inferred, { env: { GH_TOKEN: 'fixture-token' } }));
}

function githubMock(root, release, options = {}) {
    const calls = [];
    let notesPath;
    let uploadedFiles = [];
    const dependencies = {
        projectRoot: root,
        env: {},
        spawnSync(command, args) {
            calls.push([command, args]);
            return options.newRelease
                ? { status: 1, stdout: '' }
                : { status: 0, stdout: JSON.stringify({ isDraft: !options.publicRelease }) };
        },
        execFileSync(command, args) {
            calls.push([command, args]);
            if (args.includes('--notes-file')) {
                notesPath = args[args.indexOf('--notes-file') + 1];
                assert.equal(fs.readFileSync(notesPath, 'utf8'), expectedMarkdown);
            }
            if (args[1] === 'upload') {
                uploadedFiles = args
                    .filter(arg => arg.startsWith(`${path.join(root, 'release')}${path.sep}`))
                    .map(file => path.basename(file));
            }
            if (args[1] === 'view') {
                return JSON.stringify({
                    isDraft: true,
                    body: options.badBody ? 'Outdated notes' : release.markdown,
                    assets: (options.badAssets ? [...uploadedFiles, 'old-version.exe'] : uploadedFiles).map(name => ({
                        name
                    }))
                });
            }
            return '';
        }
    };
    return { calls, dependencies, notesPath: () => notesPath, uploadedFiles: () => uploadedFiles };
}

function testLocalGithubPublishing(root) {
    const release = loadReleaseNotes({ projectRoot: root });
    const distPath = path.join(root, 'release');
    fs.mkdirSync(distPath);
    const currentExe = 'NetNexus-Setup-1.2.3-win-x64.exe';
    for (const file of [
        currentExe,
        `${currentExe}.blockmap`,
        'NetNexus-Setup-1.2.2-win-x64.exe',
        'NetNexus-1.2.2-linux-x64.deb',
        'NetNexus-Setup-1.2.3-win-arm64.exe',
        'NetNexus-1.2.3-linux-x64.deb',
        'NetNexus-1.2.3-linux-arm64.deb'
    ]) {
        fs.writeFileSync(path.join(distPath, file), 'Fixture');
    }
    fs.writeFileSync(
        path.join(distPath, 'latest.yml'),
        `version: 1.2.3\npath: ${currentExe}\nfiles:\n  - url: ${currentExe}\n`
    );
    for (const newRelease of [false, true]) {
        const mock = githubMock(root, release, { newRelease });
        publishGitHubRelease(release, mock.dependencies);
        assert.deepEqual(mock.uploadedFiles().sort(), [currentExe, `${currentExe}.blockmap`, 'latest.yml'].sort());
        const commands = mock.calls.map(([, args]) => args);
        assert.ok(commands.some(args => args.includes('--notes-file')));
        assert.equal(commands[commands.length - 1].includes('--draft=false'), true);
        assert.equal(fs.existsSync(mock.notesPath()), false, 'temporary body files must be removed after publishing');
        if (newRelease)
            assert.ok(
                commands.some(args => args[1] === 'create' && args.includes('--verify-tag') && args.includes('--draft'))
            );
    }
    for (const options of [{ publicRelease: true }, { badBody: true }, { badAssets: true }]) {
        const mock = githubMock(root, release, options);
        assert.throws(() => publishGitHubRelease(release, mock.dependencies), /refusing|differ/);
        assert.equal(
            mock.calls.some(([, args]) => args.includes('--draft=false')),
            false
        );
    }
    const linux = githubMock(root, release);
    publishGitHubRelease(release, { ...linux.dependencies, target: { platform: 'linux', arch: 'arm64' } });
    assert.deepEqual(linux.uploadedFiles(), ['NetNexus-1.2.3-linux-arm64.deb']);
    const mismatch = githubMock(root, release);
    assert.throws(() => publishGitHubRelease({ ...release, tag: 'v1.2.4' }, mismatch.dependencies), /does not match/);
    assert.equal(mismatch.calls.length, 0);
    fs.writeFileSync(path.join(distPath, 'latest.yml'), 'version: 1.2.2\n');
    assert.throws(() => publishGitHubRelease(release, mismatch.dependencies), /latest\.yml does not match/);
    assert.equal(mismatch.calls.length, 0);
    fs.writeFileSync(path.join(distPath, 'latest.yml'), 'version: 1.2.3\npath: old.exe\nfiles:\n  - url: old.exe\n');
    assert.throws(() => publishGitHubRelease(release, mismatch.dependencies), /current Windows installer/);
    assert.equal(mismatch.calls.length, 0);
    assert.equal(isCurrentInstallationAsset('NetNexus-1.2.3-linux-arm64.deb', release.version), true);
    assert.equal(isCurrentInstallationAsset('NetNexus-1.2.30-linux-arm64.deb', release.version), false);
    assert.equal(isCurrentInstallationAsset('NetNexus-1.2.3-mac-arm64.dmg', release.version), false);

    assert.deepEqual(getBuildCommand(['--linux', '--arm64']), {
        command: 'npm',
        args: ['run', 'dist:linux:arm64', '--', '--publish', 'never']
    });
    const windowsBuild = getBuildCommand(['--win']);
    assert.deepEqual(windowsBuild.args.slice(-2), ['--publish', 'never']);
    for (const extraArgs of [['--publish', 'always'], ['--publish=always'], ['-p', 'always'], ['-p=always']]) {
        assert.throws(() => getBuildCommand(['--win', ...extraArgs]), /Publication flags are managed/);
    }
    const commands = [];
    const execute = (command, args) => commands.push([command, args]);
    verifyGithubPrerequisites({ execFileSync: execute, projectRoot: root, env: {} });
    assert.deepEqual(commands, [
        ['gh', ['--version']],
        ['gh', ['auth', 'status']]
    ]);
    rebuildRenderer({ execFileSync: execute, npmCli: '/fixture/npm-cli.js', projectRoot: root, env: {} });
    assert.deepEqual(commands[2], [process.execPath, ['/fixture/npm-cli.js', 'run', 'build']]);
    assert.throws(
        () =>
            verifyGithubPrerequisites({
                execFileSync: () => {
                    throw new Error('Private auth failure detail');
                }
            }),
        /GitHub CLI is unavailable/
    );
}

async function testGiteeBody(root) {
    let payload;
    const release = loadReleaseNotes({ projectRoot: root });
    await createGiteeRelease(release, {
        projectRoot: root,
        env: { GITEE_TOKEN: 'fixture-token' },
        https: {
            request(_options, callback) {
                const request = new EventEmitter();
                request.write = data => (payload = JSON.parse(data));
                request.end = () => {
                    const response = new EventEmitter();
                    response.statusCode = 201;
                    callback(response);
                    response.emit('data', JSON.stringify({ id: null }));
                    response.emit('end');
                };
                return request;
            }
        }
    });
    assert.equal(payload.body, expectedMarkdown);
    assert.equal(payload.tag_name, release.tag);
}

function testWorkflow() {
    const workflow = yaml.load(fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
    for (const jobName of ['build-windows', 'build-linux']) {
        const steps = workflow.jobs[jobName].steps;
        const notesIndex = steps.findIndex(step => step.name === 'Validate release notes');
        assert.ok(notesIndex >= 0 && notesIndex < steps.findIndex(step => step.run === 'npm ci'));
        assert.match(steps[notesIndex].run, /generate-release-notes\.js --tag "\$RELEASE_TAG"/);
    }
    const steps = workflow.jobs.publish.steps;
    const generateIndex = steps.findIndex(step => step.name === 'Generate release notes');
    const publishIndex = steps.findIndex(step => step.name === 'Stage, verify, and publish release');
    assert.ok(generateIndex >= 0 && generateIndex < publishIndex);
    const publishScript = steps[publishIndex].run;
    assert.match(publishScript, /gh release edit "\$RELEASE_TAG" --notes-file release-notes\.md/);
    assert.match(publishScript, /--notes-file release-notes\.md/);
    assert.doesNotMatch(publishScript, /--notes "自动发布|--generate-notes/);
    const readbackIndex = publishScript.indexOf("--json body --jq '.body'");
    const verifyIndex = publishScript.indexOf('--verify published-release-notes.md');
    const makePublicIndex = publishScript.indexOf('gh release edit "$RELEASE_TAG" --draft=false');
    assert.ok(readbackIndex >= 0 && readbackIndex < verifyIndex && verifyIndex < makePublicIndex);

    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.scripts['release:notes'], 'node scripts/generate-release-notes.js');
    const source = loadReleaseNotes({ projectRoot });
    for (const section of source.notes.sections) {
        assert.ok(source.markdown.includes(`## ${section.title}\n`));
        for (const item of section.items) assert.ok(source.markdown.includes(`- ${item}\n`));
    }
    const releaseScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'release.js'), 'utf8');
    assert.ok(
        releaseScript.indexOf('if (!isLinux) rebuildRenderer();') <
            releaseScript.indexOf('execFileSync(command.command')
    );
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-release-notes-'));
    try {
        testGenerator(directory);
        testCli(directory);
        testPackagingHook(directory);
        testLocalGithubPublishing(directory);
        await testGiteeBody(directory);
        testWorkflow();
        console.log('Shared module release notes, publishing validation and workflow integration tests passed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
