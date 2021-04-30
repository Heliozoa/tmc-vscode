import { expect } from "chai";
import * as cp from "child_process";
import { sync as delSync } from "del";
import * as fs from "fs-extra";
import * as path from "path";
import * as kill from "tree-kill";

import TMC from "../api/tmc";
import { SubmissionFeedback } from "../api/types";
import { CLIENT_NAME, TMC_LANGS_VERSION } from "../config/constants";
import { AuthenticationError, AuthorizationError, BottleneckError, RuntimeError } from "../errors";
import { getLangsCLIForPlatform, getPlatform } from "../utils/";

// __dirname is the dist folder when executed.
const PROJECT_ROOT = path.join(__dirname, "..");
const ARTIFACT_FOLDER = path.join(PROJECT_ROOT, "test-artifacts");

// Use CLI from backend folder to run tests.
const BACKEND_FOLDER = path.join(PROJECT_ROOT, "backend");
const CLI_PATH = path.join(BACKEND_FOLDER, "cli");
const CLI_FILE = path.join(CLI_PATH, getLangsCLIForPlatform(getPlatform(), TMC_LANGS_VERSION));
const FEEDBACK_URL = "http://localhost:4001/feedback";

// Example backend credentials
const USERNAME = "TestMyExtension";
const PASSWORD = "hunter2";

// This one is mandated by TMC-langs.
const CLIENT_CONFIG_DIR_NAME = `tmc-${CLIENT_NAME}`;

const FAIL_MESSAGE = "TMC-langs execution failed: ";

suite("tmc langs cli spec", function () {
    let server: cp.ChildProcess | undefined;

    suiteSetup(async function () {
        this.timeout(30000);
        server = await startServer();
    });

    let testDir: string;

    setup(function () {
        let testDirName = this.currentTest?.fullTitle().replace(/\s/g, "_");
        if (!testDirName) throw new Error("Illegal function call.");
        if (testDirName?.length > 72) {
            testDirName =
                testDirName.substring(0, 40) +
                ".." +
                testDirName.substring(testDirName.length - 30);
        }
        testDir = path.join(ARTIFACT_FOLDER, testDirName);
    });

    suite("authenticated user", function () {
        let onLoggedInCalls: number;
        let onLoggedOutCalls: number;
        let projectsDir: string;
        let tmc: TMC;

        setup(function () {
            const configDir = path.join(testDir, CLIENT_CONFIG_DIR_NAME);
            writeCredentials(configDir);
            onLoggedInCalls = 0;
            onLoggedOutCalls = 0;
            projectsDir = setupProjectsDir(configDir, path.join(testDir, "tmcdata"));
            tmc = new TMC(CLI_FILE, CLIENT_NAME, "test", {
                cliConfigDir: testDir,
            });
            tmc.on("login", () => onLoggedInCalls++);
            tmc.on("logout", () => onLoggedOutCalls++);
        });

        test("should not be able to re-authenticate", async function () {
            const result = await tmc.authenticate(USERNAME, PASSWORD);
            expect(result.val).to.be.instanceOf(AuthenticationError);
        });

        test("should be able to deauthenticate", async function () {
            const result1 = await tmc.deauthenticate();
            result1.err && expect.fail(FAIL_MESSAGE + result1.val.message);
            expect(onLoggedOutCalls).to.be.equal(1);

            const result2 = await tmc.isAuthenticated();
            result2.err && expect.fail(FAIL_MESSAGE + result2.val.message);
            expect(result2.val).to.be.false;

            expect(onLoggedInCalls).to.be.equal(0);
        });

        test("should be able to download an existing exercise", async function () {
            const result = await tmc.downloadExercises([1], true, () => {});
            result.err && expect.fail(`Expected operation to succeed: ${result.val.message}`);
        }).timeout(10000);

        // Missing ids are skipped for some reason
        test.skip("should not be able to download a non-existent exercise", async function () {
            const downloads = (await tmc.downloadExercises([404], true, () => {})).unwrap();
            expect(downloads.failed?.length).to.be.equal(1);
        });

        test("should get existing api data", async function () {
            const data = (await tmc.getCourseData(0)).unwrap();
            expect(data.details.name).to.be.equal("python-course");
            expect(data.exercises.length).to.be.equal(2);
            expect(data.settings.name).to.be.equal("python-course");

            const details = (await tmc.getCourseDetails(0)).unwrap().course;
            expect(details.id).to.be.equal(0);
            expect(details.name).to.be.equal("python-course");

            const exercises = (await tmc.getCourseExercises(0)).unwrap();
            expect(exercises.length).to.be.equal(2);

            const settings = (await tmc.getCourseSettings(0)).unwrap();
            expect(settings.name).to.be.equal("python-course");

            const courses = (await tmc.getCourses("test")).unwrap();
            expect(courses.length).to.be.equal(1);
            expect(courses.some((x) => x.name === "python-course")).to.be.true;

            const exercise = (await tmc.getExerciseDetails(1)).unwrap();
            expect(exercise.exercise_name).to.be.equal("part01-01_passing_exercise");

            const submissions = (await tmc.getOldSubmissions(1)).unwrap();
            expect(submissions.length).to.be.greaterThan(0);

            const organization = (await tmc.getOrganization("test")).unwrap();
            expect(organization.slug).to.be.equal("test");
            expect(organization.name).to.be.equal("Test Organization");

            const organizations = (await tmc.getOrganizations()).unwrap();
            expect(organizations.length).to.be.equal(1, "Expected to get one organization.");
        });

        test("should encounter errors when trying to get non-existing api data", async function () {
            const dataResult = await tmc.getCourseData(404);
            expect(dataResult.val).to.be.instanceOf(RuntimeError);

            const detailsResult = await tmc.getCourseDetails(404);
            expect(detailsResult.val).to.be.instanceOf(RuntimeError);

            const exercisesResult = await tmc.getCourseExercises(404);
            expect(exercisesResult.val).to.be.instanceOf(RuntimeError);

            const settingsResult = await tmc.getCourseSettings(404);
            expect(settingsResult.val).to.be.instanceOf(RuntimeError);

            const coursesResult = await tmc.getCourses("404");
            expect(coursesResult.val).to.be.instanceOf(RuntimeError);

            const exerciseResult = await tmc.getExerciseDetails(404);
            expect(exerciseResult.val).to.be.instanceOf(RuntimeError);

            const submissionsResult = await tmc.getOldSubmissions(404);
            expect(submissionsResult.val).to.be.instanceOf(RuntimeError);

            const result = await tmc.getOrganization("404");
            expect(result.val).to.be.instanceOf(RuntimeError);
        });

        test("should be able to give feedback", async function () {
            const feedback: SubmissionFeedback = {
                status: [{ question_id: 0, answer: "42" }],
            };
            const result = await tmc.submitSubmissionFeedback(FEEDBACK_URL, feedback);
            result.err && expect.fail(`Expected operation to succeed: ${result.val.message}`);
        });

        suite("with a local exercise", function () {
            this.timeout(20000);

            let exercisePath: string;

            setup(async function () {
                delSync(projectsDir, { force: true });
                const result = await tmc.downloadExercises([1], true, () => {});
                exercisePath = result.unwrap().downloaded[0].path;
            });

            test("should be able to clean the exercise", async function () {
                const result = (await tmc.clean(exercisePath)).unwrap();
                expect(result).to.be.undefined;
            });

            test("should be able to run tests for exercise", async function () {
                const result = (await tmc.runTests(exercisePath)[0]).unwrap();
                expect(result.status).to.be.equal("PASSED");
            });

            test("should be able to save the exercise state and revert it to an old submission", async function () {
                const submissions = (await tmc.getOldSubmissions(1)).unwrap();
                const result = await tmc.downloadOldSubmission(1, exercisePath, 0, true);
                result.err && expect.fail(`Expected operation to succeed: ${result.val.message}`);

                // State saving check is based on a side effect of making a new submission.
                const newSubmissions = (await tmc.getOldSubmissions(1)).unwrap();
                expect(newSubmissions.length).to.be.equal(submissions.length + 1);
            });

            test("should be able to download an old submission without saving the current state", async function () {
                const submissions = (await tmc.getOldSubmissions(1)).unwrap();
                const result = await tmc.downloadOldSubmission(1, exercisePath, 0, false);
                result.err && expect.fail(`Expected operation to succeed: ${result.val.message}`);

                // State saving check :monis based on a side effect of making a new submission.
                const newSubmissions = (await tmc.getOldSubmissions(1)).unwrap();
                expect(newSubmissions.length).to.be.equal(submissions.length);
            });

            test("should be able to save the exercise state and reset it to original template", async function () {
                const submissions = (await tmc.getOldSubmissions(1)).unwrap();
                const result = await tmc.resetExercise(1, exercisePath, true);
                result.err && expect.fail(`Expected operation to succeed: ${result.val.message}`);

                // State saving check is based on a side effect of making a new submission.
                const newSubmissions = (await tmc.getOldSubmissions(1)).unwrap();
                expect(newSubmissions.length).to.be.equal(submissions.length + 1);
            });

            test("should be able to reset exercise without saving the current state", async function () {
                const submissions = (await tmc.getOldSubmissions(1)).unwrap();
                const result = await tmc.resetExercise(1, exercisePath, false);
                result.err && expect.fail(`Expected operation to succeed: ${result.val.message}`);

                // State saving check is based on a side effect of making a new submission.
                const newSubmissions = (await tmc.getOldSubmissions(1)).unwrap();
                expect(newSubmissions.length).to.be.equal(submissions.length);
            });

            test("should be able to submit the exercise for evaluation", async function () {
                let url: string | undefined;
                const results = (
                    await tmc.submitExerciseAndWaitForResults(
                        1,
                        exercisePath,
                        undefined,
                        (x) => (url = x),
                    )
                ).unwrap();
                expect(results.status).to.be.equal("ok");
                !url && expect.fail("expected to receive submission url during submission.");
            });

            test("should encounter an error if trying to submit the exercise twice too soon", async function () {
                const first = tmc.submitExerciseAndWaitForResults(1, exercisePath);
                const second = tmc.submitExerciseAndWaitForResults(1, exercisePath);
                const [, secondResult] = await Promise.all([first, second]);
                expect(secondResult.val).to.be.instanceOf(BottleneckError);
            });

            test("should be able to submit the exercise to TMC-paste", async function () {
                const pasteUrl = (await tmc.submitExerciseToPaste(1, exercisePath)).unwrap();
                expect(pasteUrl).to.include("localhost");
            });

            test("should encounter an error if trying to submit to paste twice too soon", async function () {
                const first = tmc.submitExerciseToPaste(1, exercisePath);
                const second = tmc.submitExerciseToPaste(1, exercisePath);
                const [, secondResult] = await Promise.all([first, second]);
                expect(secondResult.val).to.be.instanceOf(BottleneckError);
            });
        });

        suite("with a missing local exercise", function () {
            let missingExercisePath: string;

            setup(async function () {
                missingExercisePath = path.join(projectsDir, "missing-course", "missing-exercise");
            });

            test("should encounter an error when attempting to clean it", async function () {
                const result = await tmc.clean(missingExercisePath);
                expect(result.val).to.be.instanceOf(RuntimeError);
            });

            test("should encounter an error when attempting to run tests for it", async function () {
                const result = await tmc.runTests(missingExercisePath)[0];
                expect(result.val).to.be.instanceOf(RuntimeError);
            });

            test("should encounter an error when attempting to revert to an older submission", async function () {
                const result = await tmc.downloadOldSubmission(1, missingExercisePath, 0, false);
                expect(result.val).to.be.instanceOf(RuntimeError);
            });

            test("should encounter an error when trying to reset it", async function () {
                const result = await tmc.resetExercise(1, missingExercisePath, false);
                expect(result.val).to.be.instanceOf(RuntimeError);
            });

            test("should encounter an error when trying to submit it", async function () {
                const result = await tmc.submitExerciseAndWaitForResults(1, missingExercisePath);
                expect(result.val).to.be.instanceOf(RuntimeError);
            });

            test("should encounter an error when trying to submit it to TMC-paste", async function () {
                const result = await tmc.submitExerciseToPaste(404, missingExercisePath);
                expect(result.val).to.be.instanceOf(RuntimeError);
            });
        });
    });

    suite("unauthenticated user", function () {
        let onLoggedInCalls: number;
        let onLoggedOutCalls: number;
        let configDir: string;
        let projectsDir: string;
        let tmc: TMC;

        setup(function () {
            configDir = path.join(testDir, CLIENT_CONFIG_DIR_NAME);
            clearCredentials(configDir);
            onLoggedInCalls = 0;
            onLoggedOutCalls = 0;
            projectsDir = setupProjectsDir(configDir, path.join(testDir, "tmcdata"));
            tmc = new TMC(CLI_FILE, CLIENT_NAME, "test", {
                cliConfigDir: testDir,
            });
            tmc.on("login", () => onLoggedInCalls++);
            tmc.on("logout", () => onLoggedOutCalls++);
        });

        // TODO: There was something fishy with this test
        test("should not be able to authenticate with empty credentials");

        test("should not be able to authenticate with incorrect credentials", async function () {
            const result = await tmc.authenticate(USERNAME, "batman123");
            expect(result.val).to.be.instanceOf(AuthenticationError);
        });

        test("should be able to authenticate with correct credentials", async function () {
            const result1 = await tmc.authenticate(USERNAME, PASSWORD);
            result1.err && expect.fail(FAIL_MESSAGE + result1.val.message);
            expect(onLoggedInCalls).to.be.equal(1);

            const result2 = await tmc.isAuthenticated();
            result2.err && expect.fail(FAIL_MESSAGE + result2.val.message);
            expect(result2.val).to.be.true;

            expect(onLoggedOutCalls).to.be.equal(0);
        });

        test("should not be able to download an exercise", async function () {
            const result = await tmc.downloadExercises([1], true, () => {});
            expect(result.val).to.be.instanceOf(RuntimeError);
        });

        test("should not get existing api data in general", async function () {
            const dataResult = await tmc.getCourseData(0);
            expect(dataResult.val).to.be.instanceOf(RuntimeError);

            const detailsResult = await tmc.getCourseDetails(0);
            expect(detailsResult.val).to.be.instanceOf(AuthorizationError);

            const exercisesResult = await tmc.getCourseExercises(0);
            expect(exercisesResult.val).to.be.instanceOf(AuthorizationError);

            const settingsResult = await tmc.getCourseSettings(0);
            expect(settingsResult.val).to.be.instanceOf(AuthorizationError);

            const coursesResult = await tmc.getCourses("test");
            expect(coursesResult.val).to.be.instanceOf(AuthorizationError);

            const exerciseResult = await tmc.getExerciseDetails(1);
            expect(exerciseResult.val).to.be.instanceOf(AuthorizationError);

            const submissionsResult = await tmc.getOldSubmissions(1);
            expect(submissionsResult.val).to.be.instanceOf(AuthorizationError);
        });

        test("should be able to get valid organization data", async function () {
            const organization = (await tmc.getOrganization("test")).unwrap();
            expect(organization.slug).to.be.equal("test");
            expect(organization.name).to.be.equal("Test Organization");

            const organizations = (await tmc.getOrganizations()).unwrap();
            expect(organizations.length).to.be.equal(1, "Expected to get one organization.");
        });

        test("should encounter error if trying to get non-existing organization data", async function () {
            const result = await tmc.getOrganization("404");
            expect(result.val).to.be.instanceOf(RuntimeError);
        });

        // This seems to ok?
        test.skip("should not be able to give feedback", async function () {
            const feedback: SubmissionFeedback = {
                status: [{ question_id: 0, answer: "42" }],
            };
            const result = await tmc.submitSubmissionFeedback(FEEDBACK_URL, feedback);
            expect(result.val).to.be.instanceOf(AuthorizationError);
        });

        suite("with a local exercise", function () {
            this.timeout(20000);

            let exercisePath: string;

            setup(async function () {
                delSync(projectsDir, { force: true });
                writeCredentials(configDir);
                const result = await tmc.downloadExercises([1], true, () => {});
                clearCredentials(configDir);
                exercisePath = result.unwrap().downloaded[0].path;
            });

            test("should be able to clean the exercise", async function () {
                const result = (await tmc.clean(exercisePath)).unwrap();
                expect(result).to.be.undefined;
            });

            test("should be able to run tests for exercise", async function () {
                const result = (await tmc.runTests(exercisePath)[0]).unwrap();
                expect(result.status).to.be.equal("PASSED");
            });

            test("should not be able to load old submission", async function () {
                const result = await tmc.downloadOldSubmission(1, exercisePath, 0, true);
                expect(result.val).to.be.instanceOf(RuntimeError);
            });

            test("should not be able to reset exercise", async function () {
                const result = await tmc.resetExercise(1, exercisePath, true);
                expect(result.val).to.be.instanceOf(AuthorizationError);
            });

            test("should not be able to submit exercise", async function () {
                const result = await tmc.submitExerciseAndWaitForResults(1, exercisePath);
                expect(result.val).to.be.instanceOf(AuthorizationError);
            });

            // This actually works
            test.skip("should not be able to submit exercise to TMC-paste", async function () {
                const result = await tmc.submitExerciseToPaste(1, exercisePath);
                expect(result.val).to.be.instanceOf(AuthorizationError);
            });
        });
    });

    suiteTeardown(function () {
        server && kill(server.pid);
    });
});

function writeCredentials(configDir: string): void {
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(
        path.join(configDir, "credentials.json"),
        '{"access_token":"1234","token_type":"bearer","scope":"public"}',
    );
}

function clearCredentials(configDir: string): void {
    delSync(configDir, { force: true });
}

function setupProjectsDir(configDir: string, projectsDir: string): string {
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(path.join(configDir, "config.toml"), `projects-dir = '${projectsDir}'\n`);
    return projectsDir;
}

async function startServer(): Promise<cp.ChildProcess> {
    let ready = false;
    console.log(path.join(__dirname, "..", "backend"));
    const server = cp.spawn("npm", ["start"], {
        cwd: path.join(__dirname, "..", "backend"),
        shell: "bash",
    });
    server.stdout.on("data", (chunk) => {
        if (chunk.toString().startsWith("Server listening to")) {
            ready = true;
        }
    });

    const timeout = setTimeout(() => {
        throw new Error("Failed to start server");
    }, 20000);

    while (!ready) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    clearTimeout(timeout);
    return server;
}
