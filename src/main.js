// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Config from './config.js';
import {ngettext} from 'gettext';
import {programInvocationName, programArgs} from 'system';

imports.package.init({
    name: Config.PACKAGE_NAME,
    version: Config.PACKAGE_VERSION,
    prefix: Config.PREFIX,
    libdir: Config.LIBDIR,
});

pkg.initGettext();
globalThis.ngettext = ngettext;

// eslint-disable-next-line no-restricted-properties
globalThis.vprintf = (fmt, ...args) => imports.format.vprintf(fmt, args);

pkg.require({
    'GdkPixbuf': '2.0',
    'GObject': '2.0',
    'Gtk': '4.0',
    'Pango': '1.0',
    'PangoCairo': '1.0',
    'Secret': '1',
    'TelepathyGLib': '0.12',
    'TelepathyLogger': '0.2',
});
pkg.requireSymbol('Gio', '2.0', 'Application.send_notification');
pkg.requireSymbol('GLib', '2.0', 'log_variant');
pkg.requireSymbol('Adw', '1', 'EntryRow');

if (!pkg.checkSymbol('Soup', '3.0'))
    pkg.requireSymbol('Soup', '2.4');

import Application from './application.js';

let application = new Application();
if (GLib.getenv('POLARI_PERSIST'))
    application.hold();
application.run([programInvocationName, ...programArgs]);
