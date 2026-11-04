'use strict';
/* The M Setup page's rows and pages: shared by the app (main.js) and the screen's layout (../layout.js).
 * live: the row controls the car itself (one state for every page), not a per-page dummy choice. */
const ROWS = [
    { key: 'engine', label: 'Engine', icon: 'GID_ICON_MOTORDYNAMIC_V01', options: ['EFFICIENT', 'SPORT', 'SPORT PLUS'] },
    { key: 'steering', label: 'Steering', icon: 'GID_ICON_SERVOTRONIC_V01', options: ['COMFORT', 'SPORT'] },
    { key: 'gearbox', label: 'Gearbox', icon: 'GID_ICON_MTRANSMISSION_V01', options: ['COMFORT', 'SPORT', 'SPORT PLUS'] },
    { key: 'xdrive', label: 'M xDrive', icon: 'GID_ICON_ALLWHEELDRIVE_V01', options: ['4WD', '2WD'], live: true },
    { key: 'exhaust', label: 'Exhaust', icon: 'GID_ICON_ENGINESOUND_V01', options: ['OPEN', 'CLOSED', 'OEM'], live: true },
];
const PAGES = [
    { key: 'setup', title: 'SETUP', label: 'SETUP', icon: 'GID_ICON_MSETUP_V01' },
    { key: 'm1', title: 'M1 CONFIGURATION', label: 'Configuration', mark: 'M1' },
    { key: 'm2', title: 'M2 CONFIGURATION', label: 'Configuration', mark: 'M2' },
];

module.exports = { ROWS, PAGES };
