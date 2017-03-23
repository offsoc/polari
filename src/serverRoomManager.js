const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const RoomManager = imports.roomManager;
const Signals = imports.signals;
const Utils = imports.utils;

const LIST_CHUNK_SIZE = 100;

let _singleton = null;

function getDefault() {
    if (_singleton == null)
        _singleton = new _ServerRoomManager();
    return _singleton;
}

const _ServerRoomManager = new Lang.Class({
    Name: '_ServerRoomManager',

    _init: function() {
        this._roomLists = new Map();

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-status-changed',
                                      Lang.bind(this, this._onAccountStatusChanged));
        this._accountsMonitor.connect('account-removed',
                                      Lang.bind(this, this._onAccountRemoved));
        this._accountsMonitor.prepare(() => {
            this._accountsMonitor.enabledAccounts.forEach(a => {
                this._onAccountStatusChanged(this._accountsMonitor, a);
            });
        });
    },

    getRoomInfos: function(account) {
        let roomList = this._roomLists.get(account);
        if (!roomList || roomList.list.listing)
            return [];
        return roomList.rooms.slice();
    },

    isLoading: function(account) {
        let roomList = this._roomLists.get(account);
        if (!roomList)
            return account.connection_status == Tp.ConnectionStatus.CONNECTING;
        return roomList.list.listing;
    },

    _onAccountStatusChanged: function(mon, account) {
        if (account.connection_status == Tp.ConnectionStatus.CONNECTING)
            this.emit('loading-changed', account);

        if (account.connection_status != Tp.ConnectionStatus.CONNECTED)
            return;

        if (this._roomLists.has(account))
            return;

        let roomList = new Tp.RoomList({ account: account });
        roomList.init_async(GLib.PRIORITY_DEFAULT, null, (o, res) => {
            try {
                roomList.init_finish(res);
            } catch(e) {
                this._roomLists.delete(account);
                return;
            }
            roomList.start();
        });
        roomList.connect('got-room', Lang.bind(this, this._onGotRoom));
        roomList.connect('notify::listing',
                         Lang.bind(this, this._onListingChanged));
        this._roomLists.set(account, { list: roomList, rooms: [] });
    },

    _onAccountRemoved: function(mon, account) {
        let roomList = this._roomLists.get(account);
        if (!roomList)
            return;

        roomList.list.run_dispose();
        this._roomLists.delete(account);
    },

    _onGotRoom: function(list, roomInfo) {
        let roomList = this._roomLists.get(list.account);
        if (!roomList)
            return;

        debug('Got room %s for account %s'.format(roomInfo.get_name(),
                                                  list.account.display_name));
        roomList.rooms.push(roomInfo);
    },

    _onListingChanged: function(list) {
        this.emit('loading-changed', list.account);
    }
});
Signals.addSignalMethods(_ServerRoomManager.prototype);


const RoomListColumn = {
    CHECKED:   0,
    NAME:      1,
    COUNT:     2,

    SENSITIVE: 3,
};

function _strBaseEqual(str1, str2) {
    return str1.localeCompare(str2, {}, { sensitivity: 'base'}) == 0;
};

const ServerRoomList = new Lang.Class({
    Name: 'ServerRoomList',
    Extends: Gtk.Box,
    Template: 'resource:///org/gnome/Polari/ui/server-room-list.ui',
    InternalChildren: ['filterEntry',
                       'list',
                       'spinner',
                       'store',
                       'toggleRenderer'],
    Properties: { 'can-join': GObject.ParamSpec.boolean('can-join',
                                                        'can-join',
                                                        'can-join',
                                                        GObject.ParamFlags.READABLE,
                                                       false)
    },

    _init: function(params) {
        this._account = null;
        this._pendingInfos = [];
        this._filterTerms = [];

        this.parent(params);

        this.connect('destroy', () => {
            this.setAccount(null);
        });

        this._list.model.set_visible_func((model, iter) => {
            let name = model.get_value(iter, RoomListColumn.NAME);
            if (!name)
                return false;

            if (this._isCustomRoomItem(iter))
                return true;

            return this._filterTerms.every((term) => name.indexOf(term) != -1);
        });

        [, this._customRoomItem] = this._store.get_iter_first();
        this._list.model.refilter();

        this._filterEntry.connect('changed', () => {
            this._updateCustomRoomName();
            this._updateSelection();
        });
        this._filterEntry.connect('search-changed', () => {
            if (!Utils.updateTerms(this._filterTerms, this._filterEntry.text))
                return;

            this._list.model.refilter();
            this._updateSelection();
        });
        this._filterEntry.connect('stop-search', () => {
            if (this._filterEntry.get_text_length() > 0)
                this._filterEntry.set_text('');
            else if (this.get_toplevel() instanceof Gtk.Dialog)
                this.get_toplevel().response(Gtk.ResponseType.CANCEL);
        });
        this._filterEntry.connect('activate', () => {
            if (this._filterEntry.text.trim().length == 0)
                return;

            let [selected, model, iter] = this._list.get_selection().get_selected();
            if (selected)
                this._toggleChecked(this._list.model.get_path(iter));
        });

        this._list.connect('row-activated', (view, path, column) => {
            this._toggleChecked(path);
        });

        this._toggleRenderer.connect('toggled', (cell, pathStr) => {
            this._toggleChecked(Gtk.TreePath.new_from_string(pathStr));
        });

        this._manager = getDefault();
        this._manager.connect('loading-changed',
                              Lang.bind(this, this._onLoadingChanged));
    },

    get can_join() {
        let canJoin = false;
        this._store.foreach((model, path, iter) => {
            canJoin = model.get_value(iter, RoomListColumn.SENSITIVE) &&
                      model.get_value(iter, RoomListColumn.CHECKED);
            return canJoin;
        });
        return canJoin;
    },

    get selectedRooms() {
        let rooms = [];
        let [valid, iter] = this._store.get_iter_first();
        for (; valid; valid = this._store.iter_next(iter)) {
            if (!this._store.get_value(iter, RoomListColumn.SENSITIVE) ||
                !this._store.get_value(iter, RoomListColumn.CHECKED))
                continue;
            rooms.push(this._store.get_value(iter, RoomListColumn.NAME));
        }
        return rooms;
    },

    setAccount: function(account) {
        if (this._account == account)
            return;

        this._account = account;
        this._pendingInfos = [];
        this._clearList();
        this._filterEntry.set_text('');
        this._onLoadingChanged(this._manager, account);
    },

    focusEntry: function() {
        this._filterEntry.grab_focus();
    },

    _isCustomRoomItem: function(iter) {
        let path = this._store.get_path(iter);
        let customPath = this._store.get_path(this._customRoomItem);
        return path.compare(customPath) == 0;
    },

    _updateCustomRoomName: function() {
        let newName = this._filterEntry.text.trim();
        if (newName.search(/\s/) != -1)
            newName = '';

        if (newName) {
            let exactMatch = false;
            this._store.foreach((model, path, iter) => {
                if (this._isCustomRoomItem(iter))
                    return false;

                let name = model.get_value(iter, RoomListColumn.NAME);
                return exactMatch = _strBaseEqual(newName, name);
            });

            if (exactMatch)
                newName = '';
        }

        this._store.set_value(this._customRoomItem, RoomListColumn.NAME, newName);
    },

    _updateSelection: function() {
        if (this._filterEntry.text.trim().length == 0)
            return;

        let model = this._list.model;
        let [valid, iter] = model.get_iter_first();
        if (!valid)
            return;

        this._list.get_selection().select_iter(iter);
        this._list.scroll_to_cell(model.get_path(iter), null, true, 0.0, 0.0);
    },

    _clearList: function() {
        let [valid, iter] = this._store.get_iter_first();
        if (this._isCustomRoomItem(iter))
            return;
        this._store.move_before(this._customRoomItem, iter);
        while (this._store.remove(iter))
            ;
    },

    _onLoadingChanged: function(mgr, account) {
        if (account != this._account)
            return;

        this._checkSpinner();

        if (this.loading)
            return;

        this._clearList();

        if (this._idleId)
            Mainloop.source_remove(this._idleId);

        if (!account)
            return;

        let roomInfos = this._manager.getRoomInfos(account);
        roomInfos.sort((info1, info2) => {
            let count1 = info1.get_members_count(null);
            let count2 = info2.get_members_count(null);
            if (count1 != count2)
                return count2 - count1;
            return info1.get_name().localeCompare(info2.get_name());
        });
        this._pendingInfos = roomInfos;

        this._checkSpinner();

        let roomManager = RoomManager.getDefault();

        this._idleId = Mainloop.idle_add(() => {
            let customName = this._store.get_value(this._customRoomItem,
                                                   RoomListColumn.NAME);
            this._pendingInfos.splice(0, LIST_CHUNK_SIZE).forEach(roomInfo => {
                let store = this._store;

                let name = roomInfo.get_name();
                if (name[0] == '#')
                    name = name.substr(1, name.length);

                if (_strBaseEqual(name, customName))
                    this._store.set_value(this._customRoomItem,
                                          RoomListColumn.NAME, customName = '');

                let room = roomManager.lookupRoomByName(roomInfo.get_name(), this._account);
                let sensitive = room == null;
                let checked = !sensitive;
                let count = '%d'.format(roomInfo.get_members_count(null));

                let iter = store.insert_with_valuesv(-1,
                                                     [RoomListColumn.CHECKED,
                                                      RoomListColumn.NAME,
                                                      RoomListColumn.COUNT,
                                                      RoomListColumn.SENSITIVE],
                                                     [checked, name, count, sensitive]);
                store.move_before(iter, this._customRoomItem);
            });
            if (this._pendingInfos.length)
                return GLib.SOURCE_CONTINUE;

            this._idleId = 0;
            this._checkSpinner();
            return GLib.SOURCE_REMOVE;
        });
    },

    _checkSpinner: function() {
        let loading = this._pendingInfos.length ||
                      (this._account && this._manager.isLoading(this._account));
        this._spinner.active = loading;
    },

    _toggleChecked: function(path) {
        let childPath = this._list.model.convert_path_to_child_path(path);
        let [valid, iter] = this._store.get_iter(childPath);
        if (!this._store.get_value(iter, RoomListColumn.SENSITIVE))
            return;
        let checked = this._store.get_value(iter, RoomListColumn.CHECKED);
        this._store.set_value(iter, RoomListColumn.CHECKED, !checked);

        this.notify('can-join');
    }
});