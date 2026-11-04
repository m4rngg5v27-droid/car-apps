#!/usr/bin/env node
'use strict';
/*
 * Builds the M Setup draft into the Store's format, like the other apps in apps/:
 *   apps/iteriodev_msetup/iteriodev_msetup@<version>.tgz   the source package (mgu-app.json, src/, the package tree)
 *   apps/iteriodev_msetup/app.json, icon.png                what the Store lists
 *   drafts/iteriodev_msetup/preview.png                     the screen as the renderer draws it (software path)
 *
 *   node drafts/iteriodev_msetup/build.js
 *
 * runtime/ is the renderer runtime the other apps ship (screenapp.js, gpu.js, widgets, kit/), copied from
 * iteriodev_tailscale 1.0.4; pkg/ the manifest and permissions of iteriodev_liveadjust 1.0.5 (with the TASU
 * diagnostic link), src/diag.js and src/tasu-guard.js from the same app.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { design } = require('./layout.js');

const ID = 'iteriodev_msetup';
const VERSION = '0.3.1';
const TITLE = 'M Setup';
const DESCRIPTION = 'DRAFT: the M Setup page laid out like the iDrive 8 one. Engine, Steering and Gearbox are dummy '
    + 'switches on SETUP, M1 and M2. M xDrive is real: 2WD switches xDrive off until the car is switched off (the DSC\'s '
    + 'own job, parked in P with the engine off; tested on G42 / G2x / G01 DSCs). Exhaust is real: Open, Closed or OEM '
    + 'for the electric exhaust flap, held by the app; Closed hands the flap back to the DME above 4500 rpm.';
const MTIME = '2026-11-04 00:00:00Z';

const HERE = __dirname;
const REPO = path.join(HERE, '..', '..');
const OUT = path.join(REPO, 'apps', ID);
const TREE = `${ID}@${VERSION}`;
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof s === 'string' || Buffer.isBuffer(s) ? s : JSON.stringify(s, null, 2) + '\n'); };
const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const n of fs.readdirSync(a)) {
    const s = path.join(a, n), d = path.join(b, n);
    if (fs.statSync(s).isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
} };

// ---- the icon: the M Setup glyph on a dark tile with the M stripes -------------------------------------------
function icon(size) {
    const { Canvas } = require('./runtime/kit/canvas');
    const W = require('./runtime/widgets');
    const cv = new Canvas(size, size), k = size / 256;
    cv.card(8 * k, 8 * k, 240 * k, 240 * k, 52 * k, [[0, '#1a2231'], [1, '#07090e']]);
    cv.strokeRoundRect(8 * k, 8 * k, 240 * k, 240 * k, 52 * k, 3 * k, '#2c3648');
    ['#81c4ff', '#16588e', '#e7222e'].forEach((c, i) => cv.roundRect((76 + i * 36) * k, 196 * k, 30 * k, 14 * k, 4 * k, c));
    W.icon(cv, 'GID_ICON_MSETUP_V01', 56 * k, 40 * k, 144 * k, '#f4f7fb');
    return cv.png();
}

// ---- RHMI host: one empty state 'home' per HMI (the renderer draws the screen over it) ------------------------
function rhmi(dir) {
    const strings = { SID_0: TITLE, SID_1: TITLE };
    write(path.join(dir, 'application.json'), {
        schemaVersion: '1.0.0',
        application: {
            uuid: '5211f83c-8c49-4257-998a-c63a8493b6bd', type: 'OnlineApp', name: ID, vendor: 'custom', version: '1.0.0',
            defaultLanguage: 'en_GB',
            uiDescriptions: ['ID7', 'ID8'].map((h) => ({ applicationFilePath: `./uiDescriptions/${h}/application.xml`,
                uiDescriptionFilePath: `./uiDescriptions/${h}/uiDescription.json`, hmi: [h] })),
            stringBundleUuid: '43eb4282-c814-4962-8a63-8c96c4db2335',
            resourceBundleUuid: '698197ac-49d0-4c6f-8094-1f75f1ca7677',
            variantGroups: [{ stringsPath: './variantGroups/Common/texts', hmi: ['ID7', 'ID8'], brands: ['BMW'], resourcesPath: './resources' }],
            entryPoints: [{ uuid: '031d6384-125a-44cd-a030-adf8ba452b21', textId: 'SID_1', insertionStateId: 20974, insertionFocusId: 2,
                appearance: 'DEFAULT', insertionMode: 'INSERT_BELOW', insertionOrder: 0, insertionPriority: 0, insertionGroup: 0,
                isGroupHeader: false, availability: 'ENABLED', icon: `${ID}_icon.png` }],
            appletId: 20125,
        },
    });
    for (const h of ['ID7', 'ID8']) {
        write(path.join(dir, 'uiDescriptions', h, 'application.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<application>
    <container id="1000" type="logical">
        <layoutGroup id="1100">
            <component id="1110" type="bookmark"/>
        </layoutGroup>
    </container>
    <container id="3000" type="state" widget="${h === 'ID8' ? 'LT_State_Wide_List' : 'LT_State_Wide'}">
        <layoutGroup id="3200" name="Titlebar">
            <component id="3220" type="title">
                <property id="2" value="1"/>
            </component>
        </layoutGroup>
        <layoutGroup id="3400" name="List">
            <property id="3" value="1"/>
        </layoutGroup>
    </container>
</application>
`);
        write(path.join(dir, 'uiDescriptions', h, 'uiDescription.json'), {
            schemaVersion: '1.3.0',
            containers: {
                1000: { type: 'logical', name: 'logicalContainer', components: { 1110: { type: 'bookmark', name: 'bookmark' } } },
                3000: { type: 'state', name: 'home', components: { 3220: { type: 'title', name: 'homeTitle',
                    rows: [{ Text: { value: 'SID_0', type: 'StringId' } }] } } },
            },
        });
    }
    for (const l of ['en_GB', 'en_US']) {
        write(path.join(dir, 'strings', `${l}.json`), strings);
        write(path.join(dir, 'variantGroups', 'Common', 'texts', `${l}.json`), strings);
    }
    write(path.join(dir, 'resources', `${ID}_icon.png`), icon(140));
}

// ---- the package ---------------------------------------------------------------------------------------------
function build() {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), `${ID}-`));
    const tree = path.join(stage, TREE);

    write(path.join(stage, 'mgu-app.json'), {
        schema: 1, id: ID, version: VERSION, tree: TREE,
        modules: ['src/main.js', 'src/exhaust.js', 'src/xdrive.js', 'src/rows.js', 'src/diag.js', 'src/tasu-guard.js', 'src/online-host.js'],
        sdk: ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging', 'oap-sdk/src/someip/someipBuilders'],
    });
    fs.mkdirSync(path.join(stage, 'src'), { recursive: true });
    for (const f of ['main.js', 'exhaust.js', 'xdrive.js', 'rows.js', 'diag.js', 'tasu-guard.js', 'online-host.js']) fs.copyFileSync(path.join(HERE, 'src', f), path.join(stage, 'src', f));

    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'pkg', 'package.json'), 'utf8'));
    Object.assign(pkg, { name: ID, version: VERSION, productName: TITLE,
        description: 'M Setup draft: the iDrive 8 M Setup page; dummy Engine / Steering / Gearbox / xDrive, real xDrive off (2E DBE1 to the DSC 0x29, parked) and exhaust flap (2F 60FD to the DME 0x12, held, rpm-guarded) over TASU; GPU renderer screen',
        mguRequires: { 'mgu-deploy': '0.7.5' }, store: { description: DESCRIPTION } });
    pkg.oapAppSettings.loggingId = 'OAA4';
    write(path.join(tree, 'package.json'), pkg);
    write(path.join(tree, 'npm-shrinkwrap.json'), { name: ID, version: VERSION, lockfileVersion: 1, requires: true, dependencies: {} });
    for (const f of ['manifest.json', 'permissions.json']) fs.copyFileSync(path.join(HERE, 'pkg', f), path.join(tree, f));
    write(path.join(tree, 'icon.png'), icon(256));
    rhmi(path.join(tree, 'rhmiData'));
    copyDir(path.join(HERE, 'runtime'), path.join(tree, 'renderer'));
    const d = design();
    write(path.join(tree, 'renderer', 'screens.json'), d);

    // the source package, packed as the other apps' are (sorted, root-owned, one date)
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of fs.readdirSync(OUT)) if (/\.tgz$/.test(f)) fs.unlinkSync(path.join(OUT, f));
    const tgz = path.join(OUT, `${TREE}.tgz`);
    execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', `--mtime=${MTIME}`,
        '-czf', tgz, '-C', stage, 'mgu-app.json', 'src', TREE]);
    write(path.join(OUT, 'app.json'), { id: ID, version: VERSION, title: TITLE, description: DESCRIPTION,
        mguHmi: ['ID7', 'ID8'], needs: ['renderer'], requires: { 'mgu-deploy': '0.7.5' } });
    write(path.join(OUT, 'icon.png'), icon(256));

    // the preview: the design with the app's first frame (render() on the default state), drawn in software
    const preview = previewPng(d);
    write(path.join(HERE, 'preview.png'), preview);
    fs.rmSync(stage, { recursive: true, force: true });
    console.log(`built ${path.relative(REPO, tgz)} (${fs.statSync(tgz).size} bytes), preview.png`);
}

function previewPng(d) {
    const { renderPng } = require('./runtime/gpu.js');
    const st = JSON.parse(JSON.stringify(d.screens[0]));
    // what main.js render() sets on the default SETUP page (the selected options in red, the focus box)
    const { ROWS } = require('./src/rows.js');
    const set = (name, o) => { const c = st.components.find((x) => x.name === name); if (c) Object.assign(c.opts, o); };
    ROWS.forEach((r) => set(`${r.key}_${r.key === 'exhaust' ? 2 : 0}`, { color: '#ff3b30' }));
    set('exhaust_sub', { text: 'The DME drives the flap · flap closed' });
    set('xdrive_sub', { text: 'xDrive active · front axle 38 Nm' });
    set('engine_0_frame', { hidden: false }); set('engine_0_fill', { hidden: false });
    // the HMI's own top and bottom bars are not ours: grey them in so the preview reads like the car
    const bars = [{ name: 'hmiTop', rtype: 'gpu', gpu: 'rect', x: 0, y: 0, w: 2880, h: 76, opts: { color: '#000000' } },
        { name: 'hmiTopText', rtype: 'gpu', gpu: 'text', x: 2500, y: 18, w: 340, h: 40, opts: { text: 'HMI status bar', size: 22, color: '#3a404a', align: 'right', font: 'label', wrap: false } },
        { name: 'hmiBottom', rtype: 'gpu', gpu: 'rect', x: 0, y: 840, w: 2880, h: 120, opts: { color: '#000000' } },
        { name: 'hmiBottomText', rtype: 'gpu', gpu: 'text', x: 0, y: 880, w: 2880, h: 40, opts: { text: 'HMI climate bar', size: 22, color: '#3a404a', align: 'center', font: 'label', wrap: false } }];
    st.components = bars.concat(st.components);
    return renderPng({ states: [st] }, 0, 'id8');
}

build();
