/**
 * -------------------------------------------------------------------------------------------------
 * Group of actions that respond to the user.
 * -------------------------------------------------------------------------------------------------
 */

import du = require("du");
import * as fs from "fs-extra";
import * as _ from "lodash";
import { Err, Ok, Result } from "ts-results";
import * as vscode from "vscode";

import { LocalCourseData } from "../api/storage";
import { SubmissionFeedback } from "../api/types";
import { WorkspaceExercise } from "../api/workspaceManager";
import { EXAM_TEST_RESULT, NOTIFICATION_DELAY } from "../config/constants";
import { BottleneckError, ConnectionError, ForbiddenError } from "../errors";
import { TestResultData } from "../ui/types";
import {
    formatSizeInBytes,
    isCorrectWorkspaceOpen,
    Logger,
    parseFeedbackQuestion,
} from "../utils/";
import { getActiveEditorExecutablePath } from "../window";

import { downloadNewExercisesForCourse } from "./downloadNewExercisesForCourse";
import { refreshLocalExercises } from "./refreshLocalExercises";
import { ActionContext, FeedbackQuestion } from "./types";
import { displayUserCourses, selectOrganizationAndCourse } from "./webview";

/**
 * Authenticates and logs the user in if credentials are correct.
 */
export async function login(
    actionContext: ActionContext,
    username: string,
    password: string,
): Promise<Result<void, Error>> {
    const { tmc } = actionContext;

    if (!username || !password) {
        return new Err(new Error("Username and password may not be empty."));
    }

    const result = await tmc.authenticate(username, password);
    if (result.err) {
        return result;
    }

    return Ok.EMPTY;
}

/**
 * Logs the user out, updating UI state
 */
export async function logout(actionContext: ActionContext): Promise<Result<void, Error>> {
    const { tmc } = actionContext;

    const result = await tmc.deauthenticate();
    if (result.err) {
        return result;
    }

    return Ok.EMPTY;
}

/**
 * Tests an exercise while keeping the user informed
 */
export async function testExercise(
    actionContext: ActionContext,
    exercise: WorkspaceExercise,
): Promise<Result<void, Error>> {
    const { dialog, ui, tmc, userData, temporaryWebviewProvider } = actionContext;

    const course = userData.getCourseByName(exercise.courseSlug);
    const exerciseId = course.exercises.find((x) => x.name === exercise.exerciseSlug)?.id;
    if (!exerciseId) {
        return Err(
            new Error(
                `ID for exercise ${exercise.courseSlug}/${exercise.exerciseSlug} was not found.`,
            ),
        );
    }

    let data: TestResultData = {
        ...EXAM_TEST_RESULT,
        id: exerciseId,
        disabled: course.disabled,
        courseSlug: course.name,
    };
    const temp = temporaryWebviewProvider.getTemporaryWebview();

    if (!course.perhapsExamMode) {
        const executablePath = getActiveEditorExecutablePath(actionContext);
        const [testRunner, interrupt] = tmc.runTests(exercise.uri.fsPath, executablePath);
        let aborted = false;
        const exerciseName = exercise.exerciseSlug;

        temp.setContent({
            title: "TMC Running tests",
            template: { templateName: "running-tests", exerciseName },
            messageHandler: async (msg: { type?: string; data?: { [key: string]: unknown } }) => {
                if (msg.type === "closeWindow") {
                    temp.dispose();
                } else if (msg.type === "abortTests") {
                    interrupt();
                    aborted = true;
                }
            },
        });
        ui.setStatusBar(`Running tests for ${exerciseName}`);
        Logger.log(`Running local tests for ${exerciseName}`);

        const testResult = await testRunner;
        if (testResult.err) {
            ui.setStatusBar(
                `Running tests for ${exerciseName} ${aborted ? "aborted" : "failed"}`,
                5000,
            );
            if (aborted) {
                temp.dispose();
                return Ok.EMPTY;
            }
            temp.setContent({
                title: "TMC",
                template: { templateName: "error", error: testResult.val },
                messageHandler: (msg: { type?: string }) => {
                    if (msg.type === "closeWindow") {
                        temp.dispose();
                    }
                },
            });
            temporaryWebviewProvider.addToRecycables(temp);
            return testResult;
        }
        ui.setStatusBar(`Tests finished for ${exerciseName}`, 5000);
        Logger.log(`Tests finished for ${exerciseName}`);
        data = {
            testResult: testResult.val,
            id: exerciseId,
            courseSlug: course.name,
            exerciseName,
            tmcLogs: {},
            disabled: course.disabled,
        };
    }

    // Set test-result handlers.
    temp.setContent({
        title: "TMC Test Results",
        template: { templateName: "test-result", ...data, pasteLink: "" },
        messageHandler: async (msg: { type?: string; data?: { [key: string]: unknown } }) => {
            if (msg.type === "submitToServer") {
                submitExercise(actionContext, exercise);
            } else if (msg.type === "sendToPaste" && msg.data) {
                const pasteResult = await pasteExercise(
                    actionContext,
                    msg.data.courseSlug as string,
                    msg.data.exerciseName as string,
                );
                if (pasteResult.err) {
                    dialog.errorNotification(
                        `Failed to send to TMC Paste: ${pasteResult.val.message}.`,
                        pasteResult.val,
                    );
                    temp.postMessage({
                        command: "showPasteLink",
                        pasteLink: `${pasteResult.val.message}`,
                    });
                } else {
                    const value = pasteResult.val || "Link not provided by server.";
                    temp.postMessage({ command: "showPasteLink", pasteLink: value });
                }
            } else if (msg.type === "closeWindow") {
                temp.dispose();
            }
        },
    });
    temporaryWebviewProvider.addToRecycables(temp);
    return Ok.EMPTY;
}

/**
 * Submits an exercise while keeping the user informed
 * @param tempView Existing TemporaryWebview to use if any
 */
export async function submitExercise(
    actionContext: ActionContext,
    exercise: WorkspaceExercise,
): Promise<Result<void, Error>> {
    const { dialog, temporaryWebviewProvider, tmc, userData } = actionContext;
    Logger.log(`Submitting exercise ${exercise.exerciseSlug} to server`);

    const course = userData.getCourseByName(exercise.courseSlug);
    const exerciseId = course.exercises.find((x) => x.name === exercise.exerciseSlug)?.id;
    if (!exerciseId) {
        return Err(
            new Error(
                `ID for exercise ${exercise.exerciseSlug}/${exercise.exerciseSlug} was not found.`,
            ),
        );
    }

    const temp = temporaryWebviewProvider.getTemporaryWebview();

    const messageHandler = async (msg: {
        data?: { [key: string]: unknown };
        type?: string;
    }): Promise<void> => {
        if (msg.type === "feedback" && msg.data) {
            await tmc.submitSubmissionFeedback(
                msg.data.url as string,
                msg.data.feedback as SubmissionFeedback,
            );
        } else if (msg.type === "showSubmissionInBrowserStatus" && msg.data) {
            vscode.env.openExternal(vscode.Uri.parse(msg.data.submissionUrl as string));
        } else if (msg.type === "showSubmissionInBrowserResult" && msg.data) {
            vscode.env.openExternal(vscode.Uri.parse(msg.data.submissionUrl as string));
        } else if (msg.type === "showSolutionInBrowser" && msg.data) {
            vscode.env.openExternal(vscode.Uri.parse(msg.data.solutionUrl as string));
        } else if (msg.type === "closeWindow") {
            temp.dispose();
        } else if (msg.type === "sendToPaste" && msg.data) {
            const pasteResult = await pasteExercise(
                actionContext,
                msg.data.courseSlug as string,
                msg.data.exerciseName as string,
            );
            if (pasteResult.err) {
                dialog.errorNotification(
                    `Failed to send to TMC Paste: ${pasteResult.val.message}.`,
                    pasteResult.val,
                );
                temp.postMessage({
                    command: "showPasteLink",
                    pasteLink: `${pasteResult.val.message}`,
                });
            } else {
                const value = pasteResult.val || "Link not provided by server.";
                temp.postMessage({ command: "showPasteLink", pasteLink: value });
            }
        }
    };

    const messages: string[] = [];
    let submissionUrl = "";
    const submissionResult = await tmc.submitExerciseAndWaitForResults(
        exerciseId,
        exercise.uri.fsPath,
        (progressPct, message) => {
            if (message && message !== _.last(messages)) {
                messages.push(message);
            }
            if (!temp.disposed) {
                temp.setContent({
                    title: "TMC Server Submission",
                    template: {
                        templateName: "submission-status",
                        messages,
                        progressPct,
                        submissionUrl,
                    },
                    messageHandler,
                });
            }
        },
        (url) => {
            submissionUrl = url;
        },
    );

    if (submissionResult.err) {
        if (submissionResult.val instanceof BottleneckError) {
            Logger.warn(`Submission was cancelled: ${submissionResult.val.message}.`);
            return Ok.EMPTY;
        }

        temp.setContent({
            title: "TMC Server Submission",
            template: { templateName: "error", error: submissionResult.val },
            messageHandler: async (msg: { type?: string }): Promise<void> => {
                if (msg.type === "closeWindow") {
                    temp.dispose();
                }
            },
        });
        temporaryWebviewProvider.addToRecycables(temp);
        return submissionResult;
    }

    const statusData = submissionResult.val;
    let feedbackQuestions: FeedbackQuestion[] = [];

    if (statusData.status === "ok" && statusData.all_tests_passed) {
        if (statusData.feedback_questions) {
            feedbackQuestions = parseFeedbackQuestion(statusData.feedback_questions);
        }
    }
    temp.setContent({
        title: "TMC Server Submission",
        template: {
            templateName: "submission-result",
            statusData,
            feedbackQuestions,
            submissionUrl,
        },
        messageHandler,
    });
    temporaryWebviewProvider.addToRecycables(temp);

    const courseData = userData.getCourseByName(exercise.courseSlug) as Readonly<LocalCourseData>;
    await checkForCourseUpdates(actionContext, courseData.id);
    vscode.commands.executeCommand("tmc.updateExercises", "silent");

    return Ok.EMPTY;
}

/**
 * Sends the exercise to the TMC Paste server.
 * @param id Exercise ID
 * @returns TMC Paste link if the action was successful.
 */
export async function pasteExercise(
    actionContext: ActionContext,
    courseSlug: string,
    exerciseName: string,
): Promise<Result<string, Error>> {
    const { tmc, userData, workspaceManager } = actionContext;

    const exerciseId = userData.getExerciseByName(courseSlug, exerciseName)?.id;
    const exercisePath = workspaceManager.getExerciseBySlug(courseSlug, exerciseName)?.uri.fsPath;
    if (!exerciseId || !exercisePath) {
        return Err(new Error("Failed to resolve exercise id"));
    }

    const pasteResult = await tmc.submitExerciseToPaste(exerciseId, exercisePath);
    if (pasteResult.err) {
        return pasteResult;
    }

    const pasteLink = pasteResult.val;
    if (pasteLink === "") {
        const message = "Didn't receive paste link from server.";
        return new Err(new Error(`Failed to send exercise to TMC Paste: ${message}`));
    }

    return new Ok(pasteLink);
}

/**
 * Check for course updates.
 * @param courseId If given, check only updates for that course.
 */
export async function checkForCourseUpdates(
    actionContext: ActionContext,
    courseId?: number,
): Promise<void> {
    const { dialog, userData } = actionContext;
    const courses = courseId ? [userData.getCourse(courseId)] : userData.getCourses();
    const filteredCourses = courses.filter((c) => c.notifyAfter <= Date.now());
    Logger.log(`Checking for course updates for courses ${filteredCourses.map((c) => c.name)}`);
    const updatedCourses: LocalCourseData[] = [];
    for (const course of filteredCourses) {
        await updateCourse(actionContext, course.id);
        updatedCourses.push(userData.getCourse(course.id));
    }

    const handleDownload = async (course: LocalCourseData): Promise<void> => {
        const downloadResult = await downloadNewExercisesForCourse(actionContext, course.id);
        if (downloadResult.err) {
            dialog.errorNotification(
                `Failed to download new exercises for course "${course.title}."`,
                downloadResult.val,
            );
        }
    };

    for (const course of updatedCourses) {
        if (course.newExercises.length > 0 && !course.disabled) {
            dialog.notification(
                `Found ${course.newExercises.length} new exercises for ${course.name}. Do you wish to download them now?`,
                ["Download", async (): Promise<void> => handleDownload(course)],
                [
                    "Remind me later",
                    (): void => {
                        userData.setNotifyDate(course.id, Date.now() + NOTIFICATION_DELAY);
                    },
                ],
                [
                    "Don't remind about these exercises",
                    (): void => {
                        userData.clearFromNewExercises(course.id);
                    },
                ],
            );
        }
    }
}

/**
 * Opens the TMC workspace in explorer. If a workspace is already opened, asks user first.
 */
export async function openWorkspace(actionContext: ActionContext, name: string): Promise<void> {
    const { dialog, resources, workspaceManager } = actionContext;
    const currentWorkspaceFile = vscode.workspace.workspaceFile;
    const tmcWorkspaceFile = resources.getWorkspaceFilePath(name);
    const workspaceAsUri = vscode.Uri.file(tmcWorkspaceFile);
    Logger.log(`Current workspace: ${currentWorkspaceFile?.fsPath}`);
    Logger.log(`TMC workspace: ${tmcWorkspaceFile}`);

    if (!isCorrectWorkspaceOpen(resources, name)) {
        if (
            !currentWorkspaceFile ||
            (await dialog.confirmation(
                "Do you want to open TMC workspace and close the current one?",
            ))
        ) {
            if (!fs.existsSync(tmcWorkspaceFile)) {
                workspaceManager.createWorkspaceFile(name);
            }
            await vscode.commands.executeCommand("vscode.openFolder", workspaceAsUri);
            // Restarts VSCode
        } else {
            const choice = "Close current & open Course Workspace";
            await dialog.warningNotification(
                "Please close the current workspace before opening a course workspace.",
                [
                    choice,
                    async (): Promise<Thenable<unknown>> => {
                        if (!fs.existsSync(tmcWorkspaceFile)) {
                            workspaceManager.createWorkspaceFile(name);
                        }
                        return vscode.commands.executeCommand("vscode.openFolder", workspaceAsUri);
                    },
                ],
            );
        }
    } else if (currentWorkspaceFile?.fsPath === tmcWorkspaceFile) {
        Logger.log("Workspace already open, changing focus to this workspace.");
        await vscode.commands.executeCommand("vscode.openFolder", workspaceAsUri);
        await vscode.commands.executeCommand("workbench.files.action.focusFilesExplorer");
    }
}

/**
 * Settings webview
 */
export async function openSettings(actionContext: ActionContext): Promise<void> {
    const { dialog, ui, resources, settings } = actionContext;
    Logger.log("Display extension settings");
    const extensionSettingsResult = await settings.getExtensionSettings();
    if (extensionSettingsResult.err) {
        dialog.errorNotification("Failed to fetch settings.", extensionSettingsResult.val);
        return;
    }

    const extensionSettings = extensionSettingsResult.val;
    ui.webview.setContentFromTemplate({ templateName: "settings" }, true, [
        {
            command: "setBooleanSetting",
            setting: "downloadOldSubmission",
            enabled: extensionSettings.hideMetaFiles,
        },
        {
            command: "setBooleanSetting",
            setting: "hideMetaFiles",
            enabled: extensionSettings.hideMetaFiles,
        },
        { command: "setBooleanSetting", setting: "insider", enabled: settings.isInsider() },
        {
            command: "setBooleanSetting",
            setting: "updateExercisesAutomatically",
            enabled: settings.getAutomaticallyUpdateExercises(),
        },
        { command: "setLogLevel", level: settings.getLogLevel() },
        {
            command: "setTmcDataFolder",
            diskSize: formatSizeInBytes(await du(resources.projectsDirectory)),
            path: resources.projectsDirectory,
        },
    ]);
}

interface NewCourseOptions {
    organization?: string;
    course?: number;
}
/**
 * Adds a new course to user's courses.
 */
export async function addNewCourse(
    actionContext: ActionContext,
    options?: NewCourseOptions,
): Promise<Result<void, Error>> {
    const { tmc, ui, userData, workspaceManager } = actionContext;
    Logger.log("Adding new course");
    let organization = options?.organization;
    let course = options?.course;

    if (!organization || !course) {
        const orgAndCourse = await selectOrganizationAndCourse(actionContext);
        if (orgAndCourse.err) {
            return orgAndCourse;
        }
        organization = orgAndCourse.val.organization;
        course = orgAndCourse.val.course;
    }

    const courseDataResult = await tmc.getCourseData(course);
    if (courseDataResult.err) {
        return courseDataResult;
    }
    const courseData = courseDataResult.val;

    let availablePoints = 0;
    let awardedPoints = 0;
    courseData.exercises.forEach((x) => {
        availablePoints += x.available_points.length;
        awardedPoints += x.awarded_points.length;
    });

    const localData: LocalCourseData = {
        description: courseData.details.description || "",
        exercises: courseData.details.exercises.map((e) => ({
            id: e.id,
            name: e.name,
            deadline: e.deadline,
            passed: e.completed,
            softDeadline: e.soft_deadline,
        })),
        id: courseData.details.id,
        name: courseData.details.name,
        title: courseData.details.title,
        organization: organization,
        availablePoints: availablePoints,
        awardedPoints: awardedPoints,
        perhapsExamMode: courseData.settings.hide_submission_results,
        newExercises: [],
        notifyAfter: 0,
        disabled: courseData.settings.disabled_status === "enabled" ? false : true,
        materialUrl: courseData.settings.material_url,
    };
    userData.addCourse(localData);
    ui.treeDP.addChildWithId("myCourses", localData.id, localData.title, {
        command: "tmc.courseDetails",
        title: "Go To Course Details",
        arguments: [localData.id],
    });
    workspaceManager.createWorkspaceFile(courseData.details.name);
    await displayUserCourses(actionContext);
    return refreshLocalExercises(actionContext);
}

/**
 * Removes given course from UserData and removes its associated files. However, doesn't remove any
 * exercises that are on disk.
 *
 * @param id ID of the course to remove
 */
export async function removeCourse(actionContext: ActionContext, id: number): Promise<void> {
    const { tmc, ui, userData, workspaceManager } = actionContext;
    const course = userData.getCourse(id);
    Logger.log(`Closing exercises for ${course.name} and removing course data from userData`);

    const unsetResult = await tmc.unsetSetting(`closed-exercises-for:${course.name}`);
    if (unsetResult.err) {
        Logger.warn(`Failed to remove TMC-langs data for "${course.name}:"`, unsetResult.val);
    }

    userData.deleteCourse(id);
    ui.treeDP.removeChildWithId("myCourses", id.toString());

    if (workspaceManager.activeCourse === course.name) {
        Logger.log("Closing course workspace because it was removed.");
        await vscode.commands.executeCommand("workbench.action.closeFolder");
    }
}

/**
 * Updates the given course by re-fetching all data from the server. Handles authorization and
 * connection errors as successful operations where the data was not actually updated.
 *
 * @param courseId ID of the course to update.
 * @returns Boolean value representing whether the data from server was successfully received.
 */
export async function updateCourse(
    actionContext: ActionContext,
    courseId: number,
): Promise<Result<boolean, Error>> {
    const { tmc, ui, userData } = actionContext;
    const postMessage = (courseId: number, disabled: boolean, exerciseIds: number[]): void => {
        ui.webview.postMessage(
            {
                command: "setNewExercises",
                courseId,
                exerciseIds,
            },
            {
                command: "setCourseDisabledStatus",
                courseId,
                disabled,
            },
        );
    };
    const courseData = userData.getCourse(courseId);
    const updateResult = await tmc.getCourseData(courseId, { forceRefresh: true });
    if (updateResult.err) {
        if (updateResult.val instanceof ForbiddenError) {
            if (!courseData.disabled) {
                Logger.warn(
                    `Failed to access information for course ${courseData.name}. Marking as disabled.`,
                );
                const course = userData.getCourse(courseId);
                await userData.updateCourse({ ...course, disabled: true });
                postMessage(course.id, true, []);
            } else {
                Logger.warn(
                    `ForbiddenError above probably caused by course still being disabled ${courseData.name}`,
                );
                postMessage(courseData.id, true, []);
            }
            return Ok(false);
        } else if (updateResult.val instanceof ConnectionError) {
            Logger.warn("Failed to fetch data from TMC servers, data not updated.");
            return Ok(false);
        } else {
            return updateResult;
        }
    }

    const { details, exercises, settings } = updateResult.val;
    const [availablePoints, awardedPoints] = exercises.reduce(
        (a, b) => [a[0] + b.available_points.length, a[1] + b.awarded_points.length],
        [0, 0],
    );

    await userData.updateCourse({
        ...courseData,
        availablePoints,
        awardedPoints,
        description: details.description || "",
        disabled: settings.disabled_status !== "enabled",
        materialUrl: settings.material_url,
        perhapsExamMode: settings.hide_submission_results,
    });

    const updateExercisesResult = await userData.updateExercises(
        courseId,
        details.exercises.map((x) => ({
            id: x.id,
            name: x.name,
            deadline: x.deadline,
            passed: x.completed,
            softDeadline: x.soft_deadline,
        })),
    );
    if (updateExercisesResult.err) {
        return updateExercisesResult;
    }

    const course = userData.getCourse(courseId);
    postMessage(course.id, course.disabled, course.newExercises);

    return Ok(true);
}
