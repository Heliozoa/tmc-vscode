import * as vscode from "vscode";

import * as actions from "../actions";
import { ActionContext } from "../actions/types";
import { Logger } from "../utils";
import { showError } from "../window";

export async function submitExercise(
    actionContext: ActionContext,
    resource: vscode.Uri | undefined,
): Promise<void> {
    const { workspaceManager } = actionContext;
    const exercise = resource
        ? workspaceManager.getExerciseByPath(resource)
        : workspaceManager.activeExercise;
    if (!exercise) {
        Logger.error("Currently open editor is not part of a TMC exercise");
        showError("Currently open editor is not part of a TMC exercise");
        return;
    }

    const result = await actions.submitExercise(actionContext, exercise);
    if (result.err) {
        Logger.error("Exercise submission failed.", result.val);
        showError("Exercise submission failed.");
        return;
    }
}
