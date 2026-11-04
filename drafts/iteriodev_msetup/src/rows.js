'use strict';
/* The M Setup page's rows and pages: shared by the app (main.js) and the screen's layout (../layout.js). */
const ROWS = [
    { key: 'engine', label: 'Engine', icon: 'GID_ICON_MOTORDYNAMIC_V01', options: ['EFFICIENT', 'SPORT', 'SPORT PLUS'] },
    { key: 'chassis', label: 'Chassis', icon: 'GID_ICON_EDC_V01', options: ['COMFORT', 'SPORT', 'SPORT PLUS'] },
    { key: 'steering', label: 'Steering', icon: 'GID_ICON_SERVOTRONIC_V01', options: ['COMFORT', 'SPORT'] },
    { key: 'brake', label: 'Brake', icon: 'GID_ICON_PARKINGBRAKE_V01', options: ['COMFORT', 'SPORT'] },
    { key: 'xdrive', label: 'M xDrive', icon: 'GID_ICON_ALLWHEELDRIVE_V01', options: ['4WD', '4WD SPORT', '2WD'] },
];
const TRACTION = { key: 'traction', label: 'M Traction Control', icon: 'GID_ICON_MTRACTION_V01', min: 0, max: 10 };
const PAGES = [
    { key: 'setup', title: 'SETUP', label: 'SETUP', icon: 'GID_ICON_MSETUP_V01' },
    { key: 'm1', title: 'M1 CONFIGURATION', label: 'Configuration', mark: 'M1' },
    { key: 'm2', title: 'M2 CONFIGURATION', label: 'Configuration', mark: 'M2' },
];


module.exports = { ROWS, TRACTION, PAGES };
