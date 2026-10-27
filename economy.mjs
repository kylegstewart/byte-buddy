// GitHub rewards replay from cached evidence; existing saved ticket awards are retained.
export const ECONOMY = {
    levels: { base: 360, step: 225 },
    evolution: { costs: [5_000, 15_000, 30_000, 50_000] },
    github: {
        opened: 10, merged: 120, reviewed: 50, constructive: 25, helpful: 25,
        clean: 30, firstPass: 15, focused: 20, complex: 30, readiness: 5,
        responsive: 10, turnaround: 10, documentation: 10, tests: 15,
        multiplier: 1,
        minLines: 5, focusedMaxLines: 400, focusedMaxFiles: 10,
        complexMinLines: 200, complexMaxLines: 1500, complexMinFiles: 3,
        reviewBodyMinLength: 40, responsiveHours: 24,
        turnaroundMinLines: 50, turnaroundMinHours: 1, turnaroundHours: 72, complexTurnaroundHours: 168,
        dailyCaps: { opened: 30, merged: 600, reviewed: 200, bonus: 150, total: 850 },
        challenges: { daily: 30, mergeWeek: 150, quality: 100, reviews: 100, constructive: 150, cleanStreak: 100, consistency: 200, improvement: 150, balanced: 100, focused: 100, team: 150,
            tests: 100, documentation: 75, helpful: 125, release: 100, reviewWeeks: 150, repositories: 150 },
    },
};

// Replay cached evidence at 75% of the original GitHub economy, including caps and challenges.
// Round each configured award to whole XP; ticket rewards and earned unlocks are unchanged.
ECONOMY.github.rewardScale = .75;
for (const key of ['opened', 'merged', 'reviewed', 'constructive', 'helpful', 'clean', 'firstPass', 'focused', 'complex', 'readiness', 'responsive', 'turnaround', 'documentation', 'tests']) {
    ECONOMY.github[key] = Math.round(ECONOMY.github[key] * ECONOMY.github.rewardScale);
}
for (const amounts of [ECONOMY.github.dailyCaps, ECONOMY.github.challenges]) {
    for (const key of Object.keys(amounts)) amounts[key] = Math.round(amounts[key] * ECONOMY.github.rewardScale);
}
