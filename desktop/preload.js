// Bridge between the app (a plain web page) and the desktop shell.
//
// contextIsolation is on and nodeIntegration is off, so the renderer cannot read
// the filesystem or open a dialog. These two calls are the whole surface it
// needs: pick a folder to clone into, and open a folder in the file manager.
// Every argument is validated in the main process before use.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('peerhub', {
	/** Native folder chooser. Resolves to an absolute path, or null if cancelled. */
	pickFolder: (title) => ipcRenderer.invoke('peerhub:pick-folder', title),

	/** Open a folder (or file) with the OS default handler. Resolves to '' on success. */
	openPath: (target) => ipcRenderer.invoke('peerhub:open-path', target)
});
