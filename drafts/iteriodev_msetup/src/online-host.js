'use strict';
/*
 * The OnlineApp host of our OAP apps, one for iDrive 7 and iDrive 8 (Node 8): the lifecycle of
 * robertnisipeanu/mgu-store's Store (apps/robertn_store/src/store.js, class Store), proven on both HMIs.
 * The unit's oap-sdk (24.x on iDrive 7, 50.x on iDrive 8; the deploy tool links it in from a stock app,
 * scripts/oap-tools/make_source_pkg.js) builds the RHMI application from rhmiData/ for the HMI it runs on;
 * the host takes it from there:
 *
 *   createHost({                     // module.exports.createHost of this file

 *       states: ['home', ...],       // the app's RHMI host states by name, the entry state first
 *       log: (text) => {},           // optional, else the SDK logger
 *       onReady(rhmiApp, hosts) {},  // hosts = { home: <state>, ... }; may return a promise
 *       onHidden() {},               // optional: the app went from visible to hidden (below)
 *       onShutdown(reason) {},       // optional, may return a promise: then the bundles go and the process exits
 *   });
 *
 * OnlineApp 'initialized' (start() is done):
 *   - no rhmiApplication (a background start reason): initialized() only, onReady is never called
 *   - else: every host state by name (one missing = the start fails) and its updateResources(), onReady, the
 *     entry point the manager hands over (application.json entryPoints: the manager inserts the tile) - init,
 *     mapEntryState(uuid, first state), text + icon, ENABLED -, registerActive() on a foreground start (tile,
 *     bookmark, voice, ...), initialized(), visible on a foreground start, then the entry point the app was
 *     started with is opened.
 * 'entryPointExecute' (tile tap while running): visible, openEntryState(uuid).
 * Visible / hidden (the Store's _setVisible): visible on a foreground start, every entryPointExecute, a host state
 * shown and an applicationStackChanged with ROOT_APP; hidden on changeVisibility false and on an
 * applicationStackChanged without ROOT_APP once the app was on screen. Each change is reported to the SDK
 * (registerActive + registerHmiVisible / unregisterHmiVisible + registerInactive; iDrive 7 only, see _setVisible);
 * hidden calls onHidden.
 * 'shutdown' (the manager stops the app): onShutdown(reason), destroyBundles(), process.exit(0).
 * Requires only oap-sdk names every donor resolves (mgu-app.json "sdk").
 */
const util = require('util');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');

// start reasons that put the app on screen (the Store's _startedForeground)
const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
const errText = (e) => String((e && e.message) || e);
const isTrue = (raw) => raw === true || raw === 'true' || raw === 1 || raw === '1';

class Host extends OnlineApp {
    constructor(opts) {
        super();
        const logger = logging.getSDKLogger();
        this._opts = opts;
        this._say = opts.log || ((text) => logger.info(text));
        this._hosts = {};
        this._shutdownPromise = null;
        this._visible = false;
        this._sawForeground = false;
        this.on('initialized', () => this._appInitialized().catch((e) => this._say(`host: start failed: ${errText(e)}`)));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) this._setVisible(false);
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (e) => this._say(`host: OnlineApp error: ${errText(e)}`));
    }

    _appInitialized() {
        const rhmi = this.rhmiApplication;
        if (!rhmi) {
            this._say('host: no RhmiApplication for this start reason; initialized without a screen');
            return this.initialized();
        }
        const states = this._opts.states;
        const foreground = this._startedForeground();
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) return;
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) this._shown();
            else if (this._sawForeground) this._setVisible(false);
        });
        return Promise.resolve()
            .then(() => {
                states.forEach((name) => {
                    this._hosts[name] = rhmi.getByName(name);
                    if (!this._hosts[name]) throw new Error(`uiDescription has no ${name}`);
                    this._hosts[name].on('visible', (ev) => { if (isTrue(ev && ev.visible)) this._shown(); });
                });
                return Promise.all(states.map((name) => this._hosts[name].updateResources()));
            })
            .then(() => this._opts.onReady(rhmi, this._hosts))
            .then(() => this._registerEntryPoint(this._hosts[states[0]]))
            .then(() => {
                // ACTIVE before initialized(): iDrive 7's SDK reports the status set by then
                if (foreground) this.registerActive();
                return this.initialized();
            })
            .then(() => {
                this._say(`host: initialized (${foreground ? 'foreground' : 'background'} start)`);
                if (foreground) this._shown();
                const uuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return uuid ? this._onEntryPointExecute(uuid) : undefined;
            });
    }

    _startedForeground() {
        const data = this.getVisibilityData && this.getVisibilityData();
        return FOREGROUND_REASONS.indexOf((data && data.reason) || this.startReason) >= 0;
    }

    /* The manager inserts the public tile from application.json and hands it to the app at start. Without it
     * the app still starts (the tile then does nothing); the Store fails its start instead. */
    _registerEntryPoint(root) {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            this._say('host: no entry point handed over by the manager');
            return Promise.resolve();
        }
        const d = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(d.uuid, root))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(d.textId))
                .then(() => (d.icon ? ours.entryPoint.setIcon(d.icon) : undefined))
                .catch((e) => this._say(`host: entry point text/icon: ${errText(e)}`)))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => this._say(`host: entry point ${d.uuid} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) return Promise.resolve();
        this._shown();
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((e) => this._say(`host: openEntryState failed: ${errText(e)}`));
    }

    _shown() {
        this._sawForeground = true;
        this._setVisible(true);
    }

    /* The Store's _setVisible: iDrive 7's OnlineApp has _initialized + _appStatusService (iDrive 8's: isInitialized +
     * appStatusService, so nothing is reported there - the Store's behaviour, proven on both). */
    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) return;
        this._visible = visible;
        this._say(`host: screen ${visible ? 'visible' : 'hidden'}`);
        if (!visible && this._opts.onHidden) {
            Promise.resolve().then(this._opts.onHidden).catch((e) => this._say(`host: onHidden failed: ${errText(e)}`));
        }
        if (!this._initialized || !this._appStatusService) return;
        const reports = visible ?
            [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report)
            .catch((e) => this._say(`host: app status report failed: ${errText(e)}`)));
    }

    _handleShutdown(reason) {
        if (this._shutdownPromise) return this._shutdownPromise;
        this._say(`host: shutting down (${util.inspect(reason, { depth: 2 })})`);
        this._shutdownPromise = Promise.resolve()
            .then(() => (this._opts.onShutdown ? this._opts.onShutdown(reason) : undefined))
            .catch((e) => this._say(`host: onShutdown failed: ${errText(e)}`))
            .then(() => this.destroyBundles())
            .catch((e) => this._say(`host: destroyBundles: ${errText(e)}`))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

/** Starts the app's OnlineApp; a failed start is logged and the process stays (the manager stops or restarts it). */
function createHost(opts) {
    if (!opts || !Array.isArray(opts.states) || !opts.states.length || typeof opts.onReady !== 'function') {
        throw new Error('createHost: states (host state names, entry state first) and onReady are required');
    }
    const host = new Host(opts);
    host.start().catch((e) => host._say(`host: OnlineApp start failed: ${errText(e)}`));
    return host;
}

module.exports = { createHost };
