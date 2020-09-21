import * as path from "path";
import * as vscode from "vscode";

import { ActionContext } from "../actions/types";

export async function showWelcome(actionContext: ActionContext): Promise<void> {
    const { resources, settings, ui } = actionContext;
    ui.webview.setContentFromTemplate(
        {
            templateName: "welcome",
            version: resources.extensionVersion,
            TMCMenuIcon: vscode.Uri.file(
                path.join(resources.mediaFolder, "welcome_tmc_menu_icon.png"),
            ),
            newTMCMenu: vscode.Uri.file(
                path.join(resources.mediaFolder, "welcome_new_tmc_menu.png"),
            ),
            newTreeView: vscode.Uri.file(
                path.join(resources.mediaFolder, "welcome_new_treeview.png"),
            ),
            actionsExplorer: vscode.Uri.file(
                path.join(resources.mediaFolder, "welcome_actions_jupyter.png"),
            ),
            tmcLogoFile: vscode.Uri.file(path.join(resources.mediaFolder, "TMC.png")),
        },
        false,
        [
            {
                key: "insiderStatus",
                message: { command: "setInsiderStatus", enabled: settings.isInsider() },
            },
        ],
    );
}
