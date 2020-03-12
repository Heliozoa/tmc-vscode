/**
 * ---------------------------------------------------------------------------------------------------------------------
 * Group of actions that respond to the user.
 * ---------------------------------------------------------------------------------------------------------------------
 */

import * as vscode from "vscode";

import { LocalCourseData } from "../config/userdata";
import TemporaryWebview from "../ui/temporaryWebview";
import { VisibilityGroups } from "../ui/treeview/types";
import { askForConfirmation, isWorkspaceOpen, sleep } from "../utils";
import { ActionContext } from "./types";
import { displayUserCourses, selectOrganizationAndCourse } from "./webview";
import { closeExercises } from "./workspace";

/**
 * Authenticates and logs the user in if credentials are correct.
 */
export async function login(
    actionContext: ActionContext, username: string, password: string, visibilityGroups: VisibilityGroups,
) {
    const { tmc, ui } = actionContext;
    const wrapError = (error: string) => `<div class="alert alert-danger fade show" role="alert">${error}</div>`;

    if (!username || !password) {
        ui.webview.setContentFromTemplate("login",
            { error: wrapError("Username and password may not be empty.") }, true);
        return;
    }

    const result = await tmc.authenticate(username, password);
    if (result.ok) {
        ui.treeDP.updateVisibility([visibilityGroups.LOGGED_IN]);
        displayUserCourses(actionContext);
    } else {
        console.log("Login failed: " + result.val.message);
        ui.webview.setContentFromTemplate("login", { error: wrapError(result.val.message) }, true);
    }
}

/**
 * Logs the user out, updating UI state
 */
export function logout(visibility: VisibilityGroups, { tmc, ui }: ActionContext) {
    tmc.deauthenticate();
    ui.webview.dispose();
    ui.treeDP.updateVisibility([visibility.LOGGED_IN.not]);
}

/**
 * Tests an exercise while keeping the user informed
 */
export async function testExercise(id: number, actions: ActionContext) {
    const { ui, resources, tmc, workspaceManager } = actions;
    const exerciseDetails = workspaceManager.getExerciseDataById(id);
    if (exerciseDetails.err) {
        vscode.window.showErrorMessage(`Getting exercise details failed: ${exerciseDetails.val.name} - ${exerciseDetails.val.message}`);
        return;
    }
    const exerciseName = exerciseDetails.val.name;
    const temp = new TemporaryWebview(resources, ui,
        "TMC Test Results", async (msg) => {
            if (msg.setToBackground) {
                temp.dispose();
            }
            if (msg.submit) {
                submitExercise(msg.exerciseId, actions, temp);
            }
        });
    temp.setContent("running-tests", { exerciseName });
    ui.setStatusBar(`Running tests for ${exerciseName}`);
    const testResult = await tmc.runTests(id);
    if (testResult.err) {
        ui.setStatusBar(`Running tests for ${exerciseName} failed`, 5000);
        vscode.window.showErrorMessage(`Exercise test run failed: \
       ${testResult.val.name} - ${testResult.val.message}`);
        return;
    }
    ui.setStatusBar(`Tests finished for ${exerciseName}`, 5000);
    const testResultVal = testResult.val;
    const data = { testResultVal, id, exerciseName };
    temp.setContent("test-result", data);
}

/**
 * Submits an exercise while keeping the user informed
 * @param tempView Existing TemporaryWebview to use if any
 */
export async function submitExercise(id: number, actionContext: ActionContext, tempView?: TemporaryWebview) {
    const { userData, ui, resources, tmc, workspaceManager } = actionContext;
    const submitResult = await tmc.submitExercise(id);

    if (submitResult.err) {
        vscode.window.showErrorMessage(`Exercise submission failed: \
            ${submitResult.val.name} - ${submitResult.val.message}`);
        return;
    }

    const messageHandler = async (msg: any) => {
        if (msg.feedback && msg.feedback.status.length > 0) {
            await tmc.submitSubmissionFeedback(msg.url, msg.feedback);
        } else if (msg.runInBackground) {
            ui.setStatusBar("Waiting for results from server.");
            temp.dispose();
        } else if (msg.showInBrowser) {
            vscode.env.openExternal(vscode.Uri.parse(submitResult.val.show_submission_url));
        } else if (msg.showSolutionInBrowser) {
            vscode.env.openExternal(vscode.Uri.parse(msg.solutionUrl));
        }
    };

    if (tempView !== undefined) {
        tempView.setMessageHandler(messageHandler);
        tempView.setTitle("TMC Server Submission");
    }

    const temp =
        tempView !== undefined ?
            tempView :
            new TemporaryWebview(resources, ui, "TMC Server Submission", messageHandler);

    let timeWaited = 0;
    let getStatus = true;
    while (getStatus) {
        const statusResult = await tmc.getSubmissionStatus(submitResult.val.submission_url);
        if (statusResult.err) {
            vscode.window.showErrorMessage(`Failed getting submission status: ${statusResult.val.name} - ${statusResult.val.message}`);
            break;
        }
        const statusData = statusResult.val;
        if (statusResult.val.status !== "processing") {
            ui.setStatusBar("Tests finished, see result", 5000);
            const feedbackQuestions:
                Array<{ id: number, kind: string, lower?: number, upper?: number, question: string }> = [];
            if (statusData.status === "ok" && statusData.all_tests_passed) {
                userData.setPassed(
                    userData.getCourseByName(workspaceManager.getExerciseDataById(id).unwrap().course).id
                    , id);
                if (statusData.feedback_questions) {
                    statusData.feedback_questions.forEach((x) => {
                        const kindRangeMatch = x.kind.match("intrange\\[(-?[0-9]+)..(-?[0-9]+)\\]");
                        if (kindRangeMatch && kindRangeMatch[0] === x.kind) {
                            feedbackQuestions.push({
                                id: x.id, kind: "intrange", lower: parseInt(kindRangeMatch[1], 10),
                                question: x.question, upper: parseInt(kindRangeMatch[2], 10),
                            });
                        } else if (x.kind === "text") {
                            feedbackQuestions.push({ id: x.id, kind: "text", question: x.question });
                        } else {
                            console.log("Unexpected feedback question type:", x.kind);
                        }
                    });
                }
            }
            temp.setContent("submission-result", { statusData, feedbackQuestions });
            break;
        }
        if (!temp.disposed) {
            temp.setContent("submission-status", statusData);
        }
        await sleep(2500);
        timeWaited = timeWaited + 2500;

        if (timeWaited === 120000) {
            vscode.window.showInformationMessage(`This seems to be taking a long time — consider continuing to the next exercise while this is running. \
                Your submission will still be graded. Check the results later at ${submitResult.val.show_submission_url}`,
                ...["Open URL and move on...", "No, I'll wait"])
                .then((selection) => {
                    if (selection === "Open URL and move on...") {
                        vscode.env.openExternal(
                            vscode.Uri.parse(submitResult.val.show_submission_url));
                        getStatus = false;
                        temp.dispose();
                    }
                });
        }
    }
}

/**
 * Opens the TMC workspace in explorer. If a workspace is already opened, asks user first.
 */
export async function openWorkspace(actionContext: ActionContext) {
    const { resources } = actionContext;
    const currentWorkspaceFile = vscode.workspace.workspaceFile;
    const tmcWorkspaceFile = vscode.Uri.file(resources.tmcWorkspaceFilePath);

    if (!isWorkspaceOpen(resources)) {
        console.log("Current workspace:", currentWorkspaceFile);
        console.log("TMC workspace:", tmcWorkspaceFile);
        if (!currentWorkspaceFile || await askForConfirmation("Do you want to open TMC workspace and close the current one?")) {
            vscode.commands.executeCommand("vscode.openFolder", tmcWorkspaceFile);
            // Restarts VSCode
        } else {
            const choice = "Close current and open TMC Workspace";
            await vscode.window.showErrorMessage("Please close your current workspace before using TestMyCode.", choice)
                .then((selection) => {
                    if (selection === choice) {
                        vscode.commands.executeCommand("vscode.openFolder", tmcWorkspaceFile);
                    }
                });
        }
    }
}

/**
 * Adds a new course to user's courses.
 */
export async function addNewCourse(actionContext: ActionContext) {
    const orgAndCourse = await selectOrganizationAndCourse(actionContext);

    if (orgAndCourse.err) {
        vscode.window.showErrorMessage(`Adding a new course failed: \
                                        ${orgAndCourse.val.name} - ${orgAndCourse.val.message}`);
        return;
    }

    const { tmc, userData } = actionContext;
    const courseDetailsResult = await tmc.getCourseDetails(orgAndCourse.val.course);
    if (courseDetailsResult.err) {
        vscode.window.showErrorMessage(`Fetching course data failed: \
                                        ${courseDetailsResult.val.name} - ${courseDetailsResult.val.message}`);
        return;
    }

    const courseDetails = courseDetailsResult.val.course;

    const localData: LocalCourseData = {
        description: courseDetails.description,
        exercises: courseDetails.exercises.map((e) => ({ id: e.id, passed: e.completed })),
        id: courseDetails.id,
        name: courseDetails.name,
        organization: orgAndCourse.val.organization,
    };
    userData.addCourse(localData);
    actionContext.ui.webview.setContentFromTemplate("index", { courses: userData.getCourses() });
}

/**
 * Removes given course from UserData and closes all its exercises.
 * @param id ID of the course to remove
 */
export async function removeCourse(id: number, actionContext: ActionContext) {
    const course = actionContext.userData.getCourse(id);
    await closeExercises(course.exercises.map((e) => e.id), actionContext);
    actionContext.userData.deleteCourse(id);
    vscode.window.showInformationMessage(`${course.name} was removed from courses.`);
}
