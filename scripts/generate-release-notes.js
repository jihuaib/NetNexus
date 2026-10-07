const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

function requireText(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Release notes ${field} must be a non-empty string`);
    }
    if (value !== value.trim() || /[\r\n]/.test(value)) {
        throw new Error(`Release notes ${field} must be a single line without surrounding whitespace`);
    }
}

function loadReleaseNotes({ projectRoot = PROJECT_ROOT, tag } = {}) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const version = packageJson.version;
    requireText(version, 'package version');
    const expectedTag = `v${version}`;
    if (tag !== undefined && tag !== expectedTag) {
        throw new Error(`Release tag ${tag} does not match package version ${expectedTag}`);
    }

    const releases = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src', 'data', 'releaseNotes.json'), 'utf8'));
    const notes = releases?.[version];
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
        throw new Error(`Release notes are missing for version ${version}`);
    }
    requireText(notes.summary, 'summary');
    if (!Array.isArray(notes.sections) || notes.sections.length === 0) {
        throw new Error(`Release notes for ${version} must contain module sections`);
    }
    const moduleTitles = new Set();
    for (const [index, section] of notes.sections.entries()) {
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
            throw new Error(`Release notes section ${index + 1} must be a module object`);
        }
        requireText(section?.title, `module title at section ${index + 1}`);
        if (moduleTitles.has(section.title)) {
            throw new Error(`Release notes module title ${section.title} is duplicated`);
        }
        moduleTitles.add(section.title);
        if (!Array.isArray(section.items) || section.items.length === 0) {
            throw new Error(`Release notes module ${section.title} must contain items`);
        }
        for (const [itemIndex, item] of section.items.entries()) {
            requireText(item, `item ${itemIndex + 1} in module ${section.title}`);
        }
    }
    const sections = notes.sections.map(
        section => `## ${section.title}\n\n${section.items.map(item => `- ${item}`).join('\n')}`
    );
    return { version, tag: expectedTag, notes, markdown: `${notes.summary}\n\n${sections.join('\n\n')}\n` };
}

function generateReleaseNotes(options) {
    return loadReleaseNotes(options).markdown;
}

function verifyReleaseNotes(expected, actual) {
    const normalize = value => value.replace(/\n+$/, '');
    if (normalize(expected) !== normalize(actual)) {
        throw new Error('Published release notes differ from the application release notes');
    }
}

function main(args = process.argv.slice(2)) {
    const options = {};
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (!['--tag', '--output', '--verify'].includes(flag)) {
            throw new Error(`Unknown release notes option: ${flag}`);
        }
        const value = args[++index];
        if (!value || value.startsWith('--')) {
            throw new Error(`${flag} requires a value`);
        }
        options[flag.slice(2)] = value;
    }
    const markdown = generateReleaseNotes({ tag: options.tag });
    if (options.verify) {
        verifyReleaseNotes(markdown, fs.readFileSync(options.verify, 'utf8'));
    }
    if (options.output) {
        fs.writeFileSync(options.output, markdown, 'utf8');
    } else if (!options.verify) {
        process.stdout.write(markdown);
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`Release notes generation failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { generateReleaseNotes, loadReleaseNotes, verifyReleaseNotes };
