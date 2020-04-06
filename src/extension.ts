import * as vscode from "vscode";
import * as init from "./init";

import TMC from "./api/tmc";
import WorkspaceManager from "./api/workspaceManager";
import Storage from "./config/storage";
import { UserData } from "./config/userdata";
import { validateAndFix } from "./config/validate";
import UI from "./ui/ui";
import { isProductionBuild } from "./utils/";
import { checkForExerciseUpdates } from "./actions";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const productionMode = isProductionBuild();
    console.log(`Starting extension in ${productionMode ? "production" : "development"} mode.`);

    vscode.workspace.onDidChangeConfiguration((settings) => {
        console.log("Asetuksia muutettiin");
        if (settings.affectsConfiguration("tmc.exerciseDownloadPath")) {
            vscode.commands.executeCommand("MoveExercises");
        }
    });

    const result = await init.resourceInitialization(context);
    if (result.err) {
        vscode.window.showErrorMessage("TestMyCode Initialization failed: " + result.val.message);
        return;
    }

    await vscode.commands.executeCommand("setContext", "tmcWorkspaceActive", true);

    const resources = result.val;
    const storage = new Storage(context);
    const ui = new UI(context, resources, vscode.window.createStatusBarItem());

    const tmc = new TMC(storage, resources);
    const validationResult = await validateAndFix(storage, tmc, ui, resources);
    if (validationResult.err) {
        vscode.window.showErrorMessage(
            "Data reconstruction failed: " + validationResult.val.message,
        );
        return;
    }

    const workspaceManager = new WorkspaceManager(storage, resources);
    tmc.setWorkspaceManager(workspaceManager);
    const userData = new UserData(storage);

    init.registerUiActions(ui, tmc, workspaceManager, resources, userData);
    const actionContext = { ui, resources, workspaceManager, tmc, userData };
    init.registerCommands(context, actionContext);

    checkForExerciseUpdates(actionContext);
}

export function deactivate(): void {}
