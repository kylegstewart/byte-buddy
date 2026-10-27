// Durable per-developer state plus all game rules. UI requests and agent actions both go through these functions.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createSplitStorage } from "./storage.mjs";
import { join } from "node:path";
import {
    ACCESSORY_SLOTS,
    ACHIEVEMENTS,
    CHALLENGES,
    DEFAULT_APPEARANCE,
    DEMO_TITLES,
    ITEMS,
    ITEM_BY_ID,
    REWARDS,
    SOURCE_DEMO,
    SOURCE_IT,
    STAGES,
    describeRequirement,
    levelCost,
    levelForXp,
    meetsRequirement,
    stageForLevel,
    xpForLevel,
} from "./catalog.mjs";

import { contributionEvents, githubChallenges, githubAnalytics, githubView } from "./github.mjs";

import { BUDDIES, newEvolution, evolutionView } from "./evolution.mjs";

export const STATE_VERSION = 6;
const emptyGitHub = () => ({ identity: null, records: {}, settings: { enabled: true, repositories: [], organizations: [], needsScope: true }, lastSync: null, lastAttempt: null, cursor: null });
// ticketSeverity on Help Desk issues at or above this value counts as a critical production issue.
export const CRITICAL_SEVERITY = 3;
const INITIAL_IMPORT_TREAT_CAP = 15;
const MAX_TREATS = 99;
const MAX_CELEBRATIONS = 25;
const MOODS = ["Happy", "Excited", "Curious", "Sleepy", "Relaxed"];

export class BuddyError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const nowIso = () => new Date().toISOString();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
let celebrationCounter = 0;
const celebrationId = () => `c${Date.now().toString(36)}${(celebrationCounter++).toString(36)}`;

function emptyProfile() {
    return {
        ledger: {},
        evolution: newEvolution(),
        github: emptyGitHub(),
        migrationXp: 0,
        treatsEarned: 0,
        treatsSpent: 0,
        unlocked: [],
        achievements: {},
        levelSeen: 1,
        challengeKeys: [],
        celebrations: [],
        lastSync: null,
        lastSyncAttempt: null,
        demoCounter: 0,
    };
}

function defaultState(userId) {
    return {
        version: STATE_VERSION,
        userId,
        createdAt: nowIso(),
        name: "Bit",
        mode: "live",
        appearance: structuredClone(DEFAULT_APPEARANCE),
        prefs: { timeOfDay: "auto", motion: "system" },
        care: {
            affection: 65,
            energy: 85,
            fullness: 60,
            sleeping: false,
            updatedAt: nowIso(),
            last: null,
            counts: { pet: 0, feed: 0, play: 0, rest: 0 },
        },
        profiles: { live: emptyProfile(), demo: emptyProfile() },
    };
}

/** Fills any fields missing from older saves so extension updates never lose progress. */
function migrate(raw, userId) {
    const base = defaultState(userId);
    if (!raw || typeof raw !== "object") return base;
    const fromVersion = Number(raw.version) || 1;
    const state = { ...base, ...raw };
    state.version = STATE_VERSION;
    delete state.connections;
    state.appearance = { ...base.appearance, ...(raw.appearance || {}) };
    if (!Array.isArray(state.appearance.furniture)) state.appearance.furniture = [...DEFAULT_APPEARANCE.furniture];
    state.prefs = { ...base.prefs, ...(raw.prefs || {}) };
    state.care = { ...base.care, ...(raw.care || {}), counts: { ...base.care.counts, ...(raw.care?.counts || {}) } };
    state.profiles = {
        live: { ...emptyProfile(), ...(raw.profiles?.live || {}) },
        demo: { ...emptyProfile(), ...(raw.profiles?.demo || {}) },
    };
    if (!["live", "demo"].includes(state.mode)) state.mode = "live";
    for (const profile of Object.values(state.profiles)) {
        profile.github = { ...emptyGitHub(), ...profile.github, settings: { ...emptyGitHub().settings, ...profile.github?.settings } };
        profile.github.settings.needsScope = !profile.github.settings.repositories.length && !profile.github.settings.organizations.length;
        for (const entry of Object.values(profile.ledger)) entry.xp ??= REWARDS[entry.kind]?.xp ?? 0;
        if (fromVersion < 3) {
            const oldXp = computeProgress(profile, userId).ticketTotalXp;
            const oldFloor = (level) => 300 * (level - 1) + 90 * (level - 1) * (level - 2);
            let level = 1;
            while (oldFloor(level + 1) <= oldXp) level++;
            const fraction = (oldXp - oldFloor(level)) / (300 + 180 * (level - 1));
            profile.migrationXp = Math.max(0, Math.ceil(xpForLevel(level) + fraction * levelCost(level) - oldXp));
        }
    }
    for (const [mode, profile] of Object.entries(state.profiles)) {
        if (!raw.profiles?.[mode]?.evolution) {
            const xp = computeProgress(profile, userId).xp;
            profile.evolution = newEvolution(xp, raw.profiles?.[mode] ? stageForLevel(levelForXp(xp)) : 1);
            profile.celebrations = profile.celebrations.map(({ stageFrom, stageTo, ...event }) => event);
        }
    }
    return state;
}

const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function startOfWeek(now) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const offset = (date.getDay() + 6) % 7; // Monday = 0
    date.setDate(date.getDate() - offset);
    return date;
}

function previousWorkingDay(date) {
    const prev = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
    while (prev.getDay() === 0 || prev.getDay() === 6) prev.setDate(prev.getDate() - 1);
    return prev;
}

/** Longest and current run of consecutive working days (weekends skipped) with at least one closed ticket. */
function streaks(dates, now) {
    const days = new Set(dates.map(dayKey));
    let longest = 0;
    for (const key of days) {
        const [y, m, d] = key.split("-").map(Number);
        const date = new Date(y, m - 1, d);
        if (days.has(dayKey(previousWorkingDay(date)))) continue; // not the start of a run
        let length = 1;
        let cursor = date;
        for (;;) {
            const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
            while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
            if (!days.has(dayKey(next))) break;
            length++;
            cursor = next;
        }
        longest = Math.max(longest, length);
    }
    let current = 0;
    let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!days.has(dayKey(cursor))) cursor = previousWorkingDay(cursor);
    while (days.has(dayKey(cursor))) {
        current++;
        cursor = previousWorkingDay(cursor);
    }
    return { longest, current };
}

export function classifyTicket(ticket) {
    if (!ticket.isIssue) return "normal";
    return Number(ticket.severity) >= CRITICAL_SEVERITY ? "critical" : "hd";
}

const HOUR_MS = 3_600_000;
const YEAR_MS = 365 * 86_400_000;
const HOLIDAYS = new Set(["1-1", "7-4", "12-24", "12-25", "12-31"]);
const REQUESTER_TIERS = [["friendly-face", 10], ["people-person", 25], ["office-hero", 50], ["company-legend", 100]];
const isPalindrome = (text) => text.length >= 3 && text === [...text].reverse().join("");

/** Every challenge occurrence earned by the rewarded tickets, as challengeId -> unique occurrence keys. */
function evaluateChallenges(entries, userId) {
    const hits = new Map(CHALLENGES.map((challenge) => [challenge.id, new Set()]));
    const hitDates = new Map();
    let currentAt = null;
    const add = (id, key, at = currentAt) => {
        hits.get(id).add(key);
        if (parseDate(at)) {
            const ref = `${id}:${key}`;
            const old = hitDates.get(ref);
            if (!old || Date.parse(at) < Date.parse(old)) hitDates.set(ref, at);
        }
    };
    const days = new Map();
    const months = new Map();
    const requesters = new Set();
    const counts = { normal: 0, hd: 0, critical: 0, difficult: 0 };
    const monthlyCounts = new Map();
    const chronological = [...entries].sort((a, b) => (Date.parse(a.closedOn || a.rewardedAt) || 0) - (Date.parse(b.closedOn || b.rewardedAt) || 0) || `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`));
    for (const entry of chronological) {
        currentAt = entry.closedOn || entry.rewardedAt;
        const ref = `${entry.source}:${entry.id}`;
        const closed = parseDate(entry.closedOn);
        const created = parseDate(entry.createdOn);
        const isHd = entry.kind !== "normal";
        counts[isHd ? "hd" : "normal"]++;
        if (entry.kind === "critical") counts.critical++;
        if (Number(entry.difficulty) >= 3) counts.difficult++;
        for (const [id, metric, target] of [["development-ten", "normal", 10], ["support-ten", "hd", 10], ["critical-five", "critical", 5], ["problem-solver", "difficult", 10]]) {
            if (counts[metric] >= target) add(id, "tier");
        }
        if (entry.requester) requesters.add(entry.requester);
        for (const [id, needed] of REQUESTER_TIERS) if (requesters.size >= needed) add(id, "tier");
        if (Number(entry.difficulty) >= 3) add("boss-fight", ref);
        if (Number(entry.timesReopened) > 0) add("second-wind", ref);
        if (userId && entry.requester === userId) add("note-to-self", ref);
        if (entry.source === SOURCE_IT && /^\d+$/.test(entry.id)) {
            if (isPalindrome(entry.id)) add("palindrome", ref);
            if (entry.id.endsWith("777")) add("lucky-sevens", ref);
            if (entry.id.includes("1337")) add("leet", ref);
            if (entry.id.endsWith("000")) add("round-number", ref);
        }
        if (!closed) continue;
        const day = dayKey(closed);
        const monthKey = day.slice(0, 7);
        const monthly = monthlyCounts.get(monthKey) || { normal: 0, hd: 0, requesters: new Set() };
        monthly[isHd ? "hd" : "normal"]++;
        if (entry.requester) monthly.requesters.add(entry.requester);
        monthlyCounts.set(monthKey, monthly);
        if (monthly.requesters.size >= 5) add("monthly-network", monthKey);
        if (monthly.normal >= 5 && monthly.hd >= 5) add("versatile-month", monthKey);
        const bucket = days.get(day) || { total: 0, hd: 0, date: closed, dates: [], hdDates: [] };
        bucket.total++;
        bucket.dates.push(entry.closedOn);
        if (isHd) { bucket.hd++; bucket.hdDates.push(entry.closedOn); }
        days.set(day, bucket);
        months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) || 0) + 1);
        const month = closed.getMonth() + 1;
        const date = closed.getDate();
        const weekday = closed.getDay();
        if (month === 3 && date === 14) add("pi-day", ref);
        if (weekday === 5 && date === 13) add("friday-13", ref);
        if (HOLIDAYS.has(`${month}-${date}`)) add("holiday-hero", ref);
        if (weekday === 0 || weekday === 6) add("weekend-warrior", ref);
        if (entry.closedExact) {
            const hour = closed.getHours();
            if (hour >= 20 || hour < 5) add("night-owl", ref);
            else if (hour < 7) add("early-bird", ref);
        }
        if (created) {
            const elapsed = closed - created;
            if (isHd && dayKey(created) === day) add("same-day-save", ref);
            if (isHd && elapsed >= 0 && elapsed <= HOUR_MS) add("speedrun", ref);
            if (elapsed > YEAR_MS) add("archaeologist", ref);
        }
    }
    const weeks = new Map();
    for (const [day, bucket] of days) {
        currentAt = bucket.date.toISOString();
        if (bucket.total >= 3) add("hat-trick", day, bucket.dates[2]);
        if (bucket.total >= 5) add("high-five", day, bucket.dates[4]);
        if (bucket.total >= 10) add("perfect-ten", day, bucket.dates[9]);
        if (bucket.hd >= 3) add("hd-blitz", day, bucket.hdDates[2]);
        const week = dayKey(startOfWeek(bucket.date));
        if (!weeks.has(week)) weeks.set(week, new Map());
        weeks.get(week).set(bucket.date.getDay(), bucket.dates[0]);
    }
    for (const [week, weekdays] of weeks) if ([1, 2, 3, 4, 5].every((d) => weekdays.has(d))) {
        add("full-week", week, weekdays.get(5));
    }
    for (const [month, count] of months) if (count >= 25) {
        const qualifying = chronological.filter((entry) => {
            const date = parseDate(entry.closedOn);
            return date && dayKey(date).startsWith(month);
        });
        add("monthly-marathon", month, qualifying[24].closedOn);
    }
    const result = new Map();
    const completions = [];
    for (const challenge of CHALLENGES) {
        const keys = [...hits.get(challenge.id)].sort();
        result.set(challenge.id, challenge.repeat === "once" ? keys.slice(0, 1).map(() => "once") : keys);
        const dates = keys.map((key) => hitDates.get(`${challenge.id}:${key}`)).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
        for (const at of challenge.repeat === "once" ? dates.slice(0, 1) : dates) completions.push({ at, xp: challenge.xp });
    }
    return { hits: result, requesters: requesters.size, completions };
}

const ticketXp = (entry) => entry.xp ?? REWARDS[entry.kind]?.xp ?? 0;

/** Pure progress calculation from a profile's ledger. */
function computeProgress(profile, userId, now = new Date()) {
    const entries = Object.values(profile.ledger);
    const rewarded = entries.filter((entry) => entry.status === "rewarded");
    const baseXp = rewarded.reduce((sum, entry) => sum + ticketXp(entry), 0);
    const { hits, requesters, completions } = evaluateChallenges(rewarded, userId);
    const timeline = new Map();
    const rowFor = (at) => {
        const date = parseDate(at);
        if (!date) return null;
        const key = dayKey(date);
        if (!timeline.has(key)) timeline.set(key, { date: key, xp: 0, baseXp: 0, bonusXp: 0, total: 0, normal: 0, hd: 0, critical: 0, reopened: 0 });
        return timeline.get(key);
    };
    let undatedXp = 0, undatedTickets = 0;
    for (const entry of rewarded) {
        const row = rowFor(entry.closedOn || entry.rewardedAt);
        if (!row) { undatedXp += ticketXp(entry); undatedTickets++; continue; }
        row.xp += ticketXp(entry);
        row.baseXp += ticketXp(entry);
        row.total++;
        row[entry.kind === 'normal' ? 'normal' : entry.kind === 'critical' ? 'critical' : 'hd']++;
    }
    for (const completion of completions) {
        const row = rowFor(completion.at);
        if (row) { row.xp += completion.xp; row.bonusXp += completion.xp; }
        else undatedXp += completion.xp;
    }
    const ticketAnalytics = { all: { timeline: [...timeline.values()].sort((a, b) => a.date.localeCompare(b.date)), undatedXp, undatedTickets } };
    for (const entry of entries.filter((entry) => entry.status === "revoked")) {
        const row = rowFor(entry.revokedAt);
        if (row) row.reopened++;
    }
    const endDay = dayKey(now);
    for (const range of ["7", "30", "90", "all"]) {
        const start = range === "all" ? "" : dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(range) + 1));
        const inRange = (value) => { const date = parseDate(value); return date && dayKey(date) >= start && dayKey(date) <= endDay; };
        const selected = range === "all" ? rewarded : rewarded.filter((entry) => inRange(entry.closedOn || entry.rewardedAt));
        const rows = [...timeline.values()].filter((row) => range === "all" || row.date >= start && row.date <= endDay).sort((a, b) => a.date.localeCompare(b.date));
        const selectedStreaks = streaks(selected.map((entry) => parseDate(entry.closedOn)).filter(Boolean), now);
        const selectedDates = selected.map((entry) => parseDate(entry.closedOn)).filter(Boolean);
        const base = selected.reduce((sum, entry) => sum + ticketXp(entry), 0);
        const bonus = range === "all" ? completions.reduce((sum, completion) => sum + completion.xp, 0) : completions.filter((completion) => inRange(completion.at)).reduce((sum, completion) => sum + completion.xp, 0);
        ticketAnalytics[range] = { timeline: rows, undatedXp: range === "all" ? undatedXp : 0, undatedTickets: range === "all" ? undatedTickets : 0,
            ticketXp: base, baseXp: base, bonusXp: bonus, ticketTotalXp: base + bonus, xp: base + bonus,
            total: selected.length, normal: selected.filter((entry) => entry.kind === "normal").length, hd: selected.filter((entry) => entry.kind !== "normal").length,
            critical: selected.filter((entry) => entry.kind === "critical").length, reopened: entries.filter((entry) => entry.status === "revoked" && (range === "all" || inRange(entry.revokedAt))).length,
            today: selectedDates.filter((date) => dayKey(date) === endDay).length,
            week: selectedDates.filter((date) => date >= startOfWeek(now)).length,
            month: selectedDates.filter((date) => date >= new Date(now.getFullYear(), now.getMonth(), 1)).length,
            currentStreak: selectedStreaks.current, longestStreak: selectedStreaks.longest };
    }
    const ghEvents = contributionEvents(profile.github.records, profile.github.identity, undefined, now);
    const ghChallenges = githubChallenges(ghEvents, rewarded, now);
    for (const row of ghChallenges.rows) hits.set(row.id, ghChallenges.completions.filter((c) => c.challengeId === row.id).map((c) => c.id.slice(row.id.length + 1)));
    const githubBaseXp = ghEvents.reduce((sum, e) => sum + e.xp, 0);
    const githubBonusXp = ghChallenges.completions.reduce((sum, e) => sum + e.xp, 0);
    let bonusXp = 0;
    let challengesCompleted = 0;
    const challengeCounts = {};
    for (const challenge of CHALLENGES) {
        const count = hits.get(challenge.id).length;
        challengeCounts[challenge.id] = count;
        if (challenge.category !== "github") bonusXp += count * challenge.xp;
        if (count) challengesCompleted++;
    }
    ticketAnalytics.all.undatedXp += bonusXp - completions.reduce((sum, completion) => sum + completion.xp, 0);
    Object.assign(ticketAnalytics.all, { bonusXp, ticketTotalXp: baseXp + bonusXp, xp: baseXp + bonusXp });
    const xp = baseXp + bonusXp + githubBaseXp + githubBonusXp + (profile.migrationXp || 0);
    const level = levelForXp(xp);
    const stage = stageForLevel(level);
    const weekStart = startOfWeek(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const today = dayKey(now);
    const dates = rewarded.map((entry) => parseDate(entry.closedOn)).filter(Boolean);
    const todays = rewarded.filter((entry) => entry.closedOn && dayKey(parseDate(entry.closedOn) || new Date(0)) === today);
    const { longest, current } = streaks(dates, now);
    const nextStage = STAGES[stage] || null;
    const githubMetrics = githubAnalytics(ghEvents, profile.github.records, profile.github.identity, ghChallenges.completions, "all", now);
    const achievementDates = {};
    const orderedTickets = [...rewarded].sort((a, b) => (Date.parse(a.closedOn || a.rewardedAt) || 0) - (Date.parse(b.closedOn || b.rewardedAt) || 0) || `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`));
    for (const achievement of ACHIEVEMENTS.filter((entry) => entry.metric)) {
        let evidence;
        if (achievement.category === "ticket") {
            const seen = new Set();
            evidence = orderedTickets.filter((entry) => {
                if (achievement.metric === "requesters") {
                    if (!entry.requester || seen.has(entry.requester)) return false;
                    seen.add(entry.requester);
                    return true;
                }
                return achievement.metric === "difficult" ? Number(entry.difficulty) >= 3 : entry.kind === achievement.metric;
            }).map((entry) => entry.closedOn || entry.rewardedAt);
        } else {
            const kind = achievement.metric === "authoredMerged" ? "merged" : achievement.metric;
            evidence = ghEvents.filter((event) => event.kind === kind).map((event) => event.at);
        }
        const at = evidence[achievement.target - 1];
        if (parseDate(at)) achievementDates[achievement.id] = at;
    }
    return {
        githubDerived: { events: ghEvents, challenges: ghChallenges, analytics: { all: githubMetrics } },
        xp,
        ticketXp: baseXp,
        ticketTotalXp: baseXp + bonusXp,
        ticketAnalytics,
        githubXp: githubBaseXp + githubBonusXp,
        githubBaseXp,
        githubBonusXp,
        migrationXp: profile.migrationXp || 0,
        githubMetrics,
        bonusXp,
        level,
        stage,
        stageLevels: STAGES.map((entry) => entry.level),
        nextStageLevel: nextStage?.level ?? null,
        nextStageXp: nextStage ? xpForLevel(nextStage.level) : null,
        levelFloorXp: xpForLevel(level),
        nextLevelXp: xpForLevel(level + 1),
        levelProgress: (xp - xpForLevel(level)) / levelCost(level),
        total: rewarded.length,
        normal: rewarded.filter((entry) => entry.kind === "normal").length,
        difficult: rewarded.filter((entry) => Number(entry.difficulty) >= 3).length,
        hd: rewarded.filter((entry) => entry.kind !== "normal").length,
        critical: rewarded.filter((entry) => entry.kind === "critical").length,
        reopened: entries.filter((entry) => entry.status === "revoked").length,
        week: dates.filter((date) => date >= weekStart).length,
        month: dates.filter((date) => date >= monthStart).length,
        today: todays.length,
        todayHd: todays.filter((entry) => entry.kind !== "normal").length,
        requesters,
        longestStreak: longest,
        currentStreak: current,
        challengesCompleted,
        secretsFound: CHALLENGES.filter((challenge) => challenge.secret && challengeCounts[challenge.id]).length,
        challengeCounts,
        challengeHits: hits,
        achievementDates,
    };
}

const SECRET_COUNT = CHALLENGES.filter((challenge) => challenge.secret).length;

function achievementMet(id, progress, careCounts = {}) {
    const hits = progress.challengeCounts;
    const definition = ACHIEVEMENTS.find((a) => a.id === id && a.metric);
    if (definition) {
        const metrics = definition.category === "ticket" ? progress : progress.githubMetrics;
        const value = definition.metric === "rounded" ? Number(progress.total >= 25 && metrics.merged >= 10 && metrics.reviewed >= 10) : metrics[definition.metric] || 0;
        return value >= definition.target;
    }
    switch (id) {
        case "first-fix": return progress.total >= 1;
        case "getting-started": return progress.total >= 10;
        case "bug-hunter": return progress.hd >= 25;
        case "firefighter": return progress.critical >= 1;
        case "on-a-roll": return progress.longestStreak >= 5;
        case "centurion": return progress.total >= 100;
        case "challenger": return progress.challengesCompleted >= 10;
        case "exterminator": return progress.hd >= 250;
        case "ticket-titan": return progress.total >= 500;
        case "veteran": return progress.level >= 40;
        case "legend": return progress.total >= 1000;
        case "warming-up": return progress.total >= 50;
        case "on-call": return progress.hd >= 50;
        case "networker": return progress.requesters >= 50;
        case "sleuth": return progress.secretsFound >= 3;
        case "quarter-grand": return progress.total >= 250;
        case "best-friends": return (careCounts.pet || 0) >= 100;
        case "snack-attack": return (careCounts.feed || 0) >= 25;
        case "playmate": return (careCounts.play || 0) >= 50;
        case "speed-demon": return hits.speedrun >= 50;
        case "triple-threat": return hits["hat-trick"] >= 50;
        case "high-roller": return hits["high-five"] >= 10;
        case "relic-hunter": return hits.archaeologist >= 30;
        case "marathoner": return hits["monthly-marathon"] >= 6;
        case "same-day-pro": return hits["same-day-save"] >= 300;
        case "unstoppable": return progress.longestStreak >= 10;
        case "iron-will": return progress.longestStreak >= 20;
        case "completionist": return progress.challengesCompleted >= 20;
        case "master-detective": return progress.secretsFound >= SECRET_COUNT;
        case "socialite": return progress.requesters >= 150;
        case "three-quarters": return progress.total >= 750;
        case "help-desk-hero": return progress.hd >= 500;
        case "maxed-out": return progress.level >= 50;
        default: return false;
    }
}

function pushCelebration(profile, celebration) {
    profile.celebrations.push({ id: celebrationId(), at: nowIso(), ...celebration });
    if (profile.celebrations.length > MAX_CELEBRATIONS) profile.celebrations.splice(0, profile.celebrations.length - MAX_CELEBRATIONS);
}

/**
 * Applies permanent unlocks (achievements, items, challenge payouts) and level-change celebrations.
 * Unlocks are never removed, even if XP later drops because a ticket was reopened.
 */
function settleProfile(profile, { quiet = false, userId = null, careCounts = {}, progress = computeProgress(profile, userId) } = {}) {
    const newAchievements = [];
    for (const achievement of ACHIEVEMENTS) {
        if (!profile.achievements[achievement.id] && achievementMet(achievement.id, progress, careCounts)) {
            profile.achievements[achievement.id] = profile.previousAchievements?.[achievement.id] || progress.achievementDates[achievement.id] || nowIso();
            newAchievements.push(achievement);
        }
    }
    const unlocked = new Set(profile.unlocked);
    const newItems = [];
    for (const item of ITEMS) {
        if (!unlocked.has(item.id) && meetsRequirement(item.req, { level: progress.level, hdCount: progress.hd, achievements: profile.achievements })) {
            unlocked.add(item.id);
            if (item.req) newItems.push(item);
        }
    }
    profile.unlocked = [...unlocked];

    const seenKeys = new Set(profile.challengeKeys);
    const newChallenges = [];
    for (const challenge of CHALLENGES) {
        const fresh = progress.challengeHits.get(challenge.id).filter((key) => !seenKeys.has(`${challenge.id}:${key}`));
        if (!fresh.length) continue;
        for (const key of fresh) seenKeys.add(`${challenge.id}:${key}`);
        newChallenges.push({ id: challenge.id, name: challenge.name, count: fresh.length, xp: fresh.length * challenge.xp, treats: fresh.length * challenge.treats, secret: Boolean(challenge.secret) });
    }
    profile.challengeKeys = [...seenKeys];

    if (!quiet) {
        if (newChallenges.length) {
            profile.treatsEarned += newChallenges.reduce((sum, challenge) => sum + challenge.treats, 0);
            pushCelebration(profile, { type: "challenges", items: newChallenges, xp: newChallenges.reduce((sum, challenge) => sum + challenge.xp, 0) });
        }
        if (progress.level > profile.levelSeen) {
            pushCelebration(profile, {
                type: "levelup",
                from: profile.levelSeen,
                to: progress.level,
                // Evolution is purchased independently of overall level.
            });
        }
        for (const achievement of newAchievements) pushCelebration(profile, { type: "achievement", achievementId: achievement.id, name: achievement.name });
        if (newItems.length) pushCelebration(profile, { type: "unlock", items: newItems.map((item) => ({ id: item.id, name: item.name, slot: item.slot })) });
    }
    profile.levelSeen = progress.level;
    return { progress, newAchievements, newItems, newChallenges };
}

function deriveMood(care, now = Date.now()) {
    if (care.sleeping) return "Sleepy";
    const last = care.last;
    const recent = last && now - Date.parse(last.at) < 25_000;
    if (recent && last.type === "pet") return "Happy";
    if (recent && ["feed", "play", "levelup"].includes(last.type)) return "Excited";
    if (recent && last.type === "wake") return "Curious";
    if (care.energy < 30) return "Sleepy";
    if (care.affection >= 80) return "Happy";
    return ["Relaxed", "Curious", "Relaxed"][Math.floor(now / 420_000) % 3];
}

/** Gentle drift toward comfortable floors; Byte Buddy never becomes unhappy or loses progress from inactivity. */
function tickCare(care, now = Date.now()) {
    const minutes = Math.max(0, (now - Date.parse(care.updatedAt)) / 60_000);
    if (!minutes) return care;
    care.affection = clamp(care.affection - minutes * 0.04, Math.min(care.affection, 40), 100);
    care.fullness = clamp(care.fullness - minutes * 0.05, 35, 100);
    care.energy = care.sleeping ? clamp(care.energy + minutes * 2, 0, 100) : clamp(care.energy - minutes * 0.03, 30, 100);
    care.updatedAt = new Date(now).toISOString();
    return care;
}

function careView(care) {
    return {
        affection: Math.round(care.affection),
        energy: Math.round(care.energy),
        fullness: Math.round(care.fullness),
        sleeping: care.sleeping,
        last: care.last,
        counts: care.counts,
    };
}

export function createStore({ root, userId }) {
    const dir = join(root, "artifacts", userId.replace(/[^A-Za-z0-9._-]/g, "_"));
    const legacyFile = join(dir, "buddy.json");
    const backup = join(dir, "buddy.backup.json");
    const storage = createSplitStorage(dir);
    const file = storage.file;
    const projectionSignature = createHash("sha256").update(["store.mjs", "github.mjs", "economy.mjs", "catalog.mjs"].map((name) => readFileSync(new URL(name, import.meta.url))).join("\n")).digest("hex");
    const events = new EventEmitter();
    const runtime = { syncing: false, syncProgress: null, handoffPending: false };
    let state = null;
    const revisions = new WeakMap();
    const progressCache = new WeakMap();
    // Care, unlocks, settings, and runtime metadata are read fresh; only evidence changes bump this revision.
    const invalidate = (profile, kind = null) => {
        revisions.set(profile, (revisions.get(profile) || 0) + 1);
        const mode = Object.keys(state?.profiles || {}).find((key) => state.profiles[key] === profile);
        if (mode) for (const source of kind ? [kind] : ["tickets", "github"]) storage.mark(mode, source);
    };
    function progressOf(profile) {
        const now = new Date();
        const day = `${dayKey(now)}:${now.toISOString().slice(0, 10)}`;
        const revision = revisions.get(profile) || 0;
        const cached = progressCache.get(profile);
        if (cached?.revision === revision && cached.day === day && now.getTime() >= cached.computedAt && now.getTime() < cached.expiresAt) return cached.progress;
        const progress = computeProgress(profile, userId, now);
        // Rolling analytics expire at their actual evidence boundaries, not only at midnight.
        let expiresAt = Infinity;
        const consider = (value) => {
            const at = Date.parse(value || "");
            for (const offset of [0, 7 * 86_400_000 + 1, 30 * 86_400_000 + 1, 90 * 86_400_000 + 1]) {
                if (at + offset > now.getTime()) expiresAt = Math.min(expiresAt, at + offset);
            }
        };
        for (const event of [...progress.githubDerived.events, ...progress.githubDerived.challenges.completions]) consider(event.at);
        for (const record of Object.values(profile.github.records)) {
            for (const value of [record.createdAt, record.mergedAt, record.closedAt]) consider(value);
            for (const review of record.reviews || []) consider(review.submittedAt || review.createdAt);
            for (const comment of record.comments || []) consider(comment.createdAt);
        }
        const github = githubView(profile, Object.values(profile.ledger).filter((entry) => entry.status === "rewarded"), now, progress.githubDerived);
        progressCache.set(profile, { revision, day, expiresAt, computedAt: now.getTime(), progress, github, recent: recentTickets(profile),
            key: `${projectionSignature}:${randomUUID()}` });
        return progress;
    }
    const settle = (profile, options = {}) => settleProfile(profile, { ...options, userId, careCounts: state?.care?.counts, progress: progressOf(profile) });

    function load() {
        if (state) return state;
        mkdirSync(dir, { recursive: true });
        const split = storage.read();
        let raw = split?.state ?? null;
        if (!split) for (const candidate of [legacyFile, backup]) {
            if (!existsSync(candidate)) continue;
            try {
                raw = JSON.parse(readFileSync(candidate, "utf8"));
                break;
            } catch { /* try backup */ }
        }
        state = split && raw.version === STATE_VERSION ? raw : migrate(raw, userId);
        if (split && raw.version === STATE_VERSION) for (const mode of ["live", "demo"]) {
            const cached = split.projections[mode];
            if (!cached?.key?.startsWith(`${projectionSignature}:`) || !cached.progress || !cached.github || !Array.isArray(cached.progress.challengeHits)) continue;
            cached.progress.challengeHits = new Map(cached.progress.challengeHits);
            cached.github.summary = cached.github.analytics.all;
            cached.progress.githubMetrics = cached.careerGithubMetrics;
            cached.expiresAt = cached.expiresAt ?? Infinity;
            cached.revision = 0;
            progressCache.set(state.profiles[mode], cached);
        }
        let announced = false;
        for (const [mode, profile] of Object.entries(state.profiles)) {
            const { newAchievements, newItems } = settle(profile, { quiet: true });
            // Rewards added by an extension update and already earned get one summary popup instead of a silent unlock.
            if (raw && mode === "live" && !profile.rebalancePending && (newAchievements.length || newItems.length)) {
                pushCelebration(profile, { type: "newcontent", achievements: newAchievements.map((a) => a.name), items: newItems.map((i) => i.name) });
                announced = true;
            }
        }
        const rebuilt = split && ["live", "demo"].some((mode) => split.projections[mode]?.key !== progressCache.get(state.profiles[mode])?.key);
        if (!split || raw.version !== STATE_VERSION || announced || rebuilt) save();
        return state;
    }

    function save() {
        const projections = {};
        for (const mode of ["live", "demo"]) {
            const profile = state.profiles[mode];
            const xp = progressOf(profile).xp;
            if (profile.evolution.xp !== xp) {
                profile.evolution.xp = xp;
                profile.evolution.revision++;
            }
            const cached = progressCache.get(profile);
            // Evidence-derived events stay in memory only; summaries share the canonical analytics on reload.
            const { githubDerived, githubMetrics, ...progress } = cached.progress;
            const { events, summary, ...github } = cached.github;
            projections[mode] = { ...cached, careerGithubMetrics: githubMetrics, progress: { ...progress, challengeHits: [...cached.progress.challengeHits] }, github };
        }
        storage.write(state, projections);
    }

    function analyticsRevision() {
        const profile = profileOf();
        progressOf(profile);
        return `${load().mode}:${progressCache.get(profile).key}`;
    }

    function analytics({ source, range = "all", offset = 0, limit = 180, revision = null } = {}) {
        if (!["ticket", "github"].includes(source) || !["7", "30", "90", "all"].includes(range) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 366) throw new BuddyError("invalid_analytics", "Choose a valid source, range and page (1–366 rows).");
        const currentRevision = analyticsRevision();
        if (revision && revision !== currentRevision) throw new BuddyError("analytics_changed", "Analytics changed; reload this range.");
        const profile = profileOf();
        const progress = progressOf(profile);
        const ranges = source === "ticket" ? progress.ticketAnalytics : progressCache.get(profile).github.analytics;
        const { timeline, ...metrics } = ranges[range];
        let cumulativeXp = 0;
        const running = new Map(ranges.all.timeline.map((row) => { cumulativeXp += row.xp || 0; return [row.date, cumulativeXp]; }));
        const selected = timeline.slice(offset, offset + limit).map((row) => ({ ...row, cumulativeXp: running.get(row.date) ?? cumulativeXp }));
        return structuredClone({ revision: currentRevision, source, range, metrics, timeline: selected, offset, limit, total: timeline.length, hasMore: offset + limit < timeline.length });
    }

    const profileOf = (mode) => load().profiles[mode ?? load().mode];

    function commit(fx) {
        save();
        events.emit("change");
        if (fx) events.emit("fx", fx);
    }

    function isUnlocked(itemId, profile = profileOf()) {
        const item = ITEM_BY_ID.get(itemId);
        return Boolean(item) && (!item.req || profile.unlocked.includes(itemId));
    }

    /** Appearance with anything not unlocked in the active mode stripped (demo unlocks never leak into live). */
    function effectiveAppearance() {
        const { appearance } = load();
        const profile = profileOf();
        const pick = (slot) => (appearance[slot] && isUnlocked(appearance[slot], profile) ? appearance[slot] : DEFAULT_APPEARANCE[slot]);
        const result = {};
        for (const slot of ["bodyColor", "eyeColor", "variant", "wall", "room", ...ACCESSORY_SLOTS]) result[slot] = pick(slot);
        result.furniture = appearance.furniture.filter((id) => isUnlocked(id, profile));
        return result;
    }

    function recentTickets(profile, limit = 12) {
        return Object.values(profile.ledger)
            .sort((a, b) => String(b.closedOn || b.rewardedAt).localeCompare(String(a.closedOn || a.rewardedAt)))
            .slice(0, limit)
            .map(({ id, source, title, kind, xp, status, closedOn }) => ({ id, source, title, kind, xp, status, closedOn, demo: source === SOURCE_DEMO }));
    }

    function view({ summary = false } = {}) {
        const current = load();
        tickCare(current.care);
        const profile = profileOf();
        const { challengeHits, challengeCounts, ticketAnalytics, githubDerived, achievementDates, ...progress } = progressOf(profile);
        const evolution = evolutionView(profile.evolution, progress.xp);
        const cached = progressCache.get(profile);
        const github = { ...cached.github, identity: profile.github.identity, settings: profile.github.settings, lastSync: profile.github.lastSync, lastAttempt: profile.github.lastAttempt };
        const githubRows = new Map(github.challenges.rows.map((c) => [c.id, c]));
        if (summary) delete progress.githubMetrics;
        const { timeline: ignoredTimeline, ...githubSummary } = github.summary;
        return structuredClone({
            userId,
            name: current.name,
            mode: current.mode,
            prefs: current.prefs,
            appearance: effectiveAppearance(),
            care: careView(current.care),
            mood: deriveMood(current.care),
            analyticsRevision: analyticsRevision(),
            ...(summary ? {} : { ticketAnalytics }),
            treats: Math.min(MAX_TREATS, profile.treatsEarned - profile.treatsSpent),
            evolution,
            progress: { ...progress, stage: evolution.stage, stageName: evolution.stageName, stageBlurb: "Evolve manually using shared evolution credits.", stages: evolution.types.find((type) => type.id === evolution.active).stages, stageLevels: [], nextStageLevel: null, nextStageXp: null },
            achievements: ACHIEVEMENTS.map((achievement) => ({
                id: achievement.id,
                name: achievement.name,
                description: achievement.description,
                category: achievement.category || "ticket",
                tier: achievement.tier || null,
                unlockedAt: profile.achievements[achievement.id] || null,
                rewards: achievement.rewards.map((id) => ITEM_BY_ID.get(id)?.name ?? id),
            })),
            challenges: CHALLENGES.map((challenge) => {
                if (githubRows.has(challenge.id)) return githubRows.get(challenge.id);
                const count = challengeCounts[challenge.id];
                const hidden = challenge.secret && !count;
                return {
                    id: challenge.id,
                    category: "ticket",
                    name: hidden ? "???" : challenge.name,
                    description: hidden ? "Secret challenge. Keep closing tickets to discover it." : challenge.description,
                    xp: challenge.xp,
                    treats: challenge.treats,
                    repeat: challenge.repeat,
                    secret: Boolean(challenge.secret),
                    count,
                    xpEarned: count * challenge.xp,
                };
            }),
            github: { ...github, ...(summary ? { analytics: undefined, summary: githubSummary } : {}), events: undefined, challenges: undefined, syncing: current.mode === "live" && Boolean(runtime.githubSyncing), progress: runtime.githubProgress || null },
            recent: cached.recent,
            celebrations: profile.celebrations,
            sync: {
                last: profile.lastSync,
                lastAttempt: profile.lastSyncAttempt,
                syncing: current.mode === "live" && runtime.syncing,
                progress: runtime.syncProgress,
                handoffPending: runtime.handoffPending,
            },
            catalog: catalog(),
        });
    }

    function catalog() {
        const profile = profileOf();
        const appearance = effectiveAppearance();
        return ITEMS.map((item) => ({
            id: item.id,
            slot: item.slot,
            name: item.name,
            color: item.color ?? null,
            unlocked: isUnlocked(item.id, profile),
            requirement: describeRequirement(item.req),
            equipped: item.slot === "furniture" ? appearance.furniture.includes(item.id) : appearance[item.slot] === item.id,
        }));
    }

    function interact(action, origin = "ui") {
        const current = load();
        const care = tickCare(current.care);
        const profile = profileOf();
        const at = nowIso();
        switch (action) {
            case "fling":
                if (Date.now() - Date.parse(care.lastFlingAt || "1970-01-01") < 5000) {
                    return { action, mood: deriveMood(care), care: structuredClone(careView(care)), treats: profile.treatsEarned - profile.treatsSpent };
                }
                care.affection = clamp(care.affection - 5, 0, 100);
                care.lastFlingAt = at;
                break;
            case "pet":
                care.affection = clamp(care.affection + 8, 0, 100);
                break;
            case "feed": {
                if (profile.treatsEarned - profile.treatsSpent <= 0) {
                    throw new BuddyError("no_treats", "No treats left. Close tickets to earn more!");
                }
                profile.treatsSpent++;
                care.sleeping = false;
                care.fullness = clamp(care.fullness + 25, 0, 100);
                care.affection = clamp(care.affection + 3, 0, 100);
                care.energy = clamp(care.energy + 5, 0, 100);
                break;
            }
            case "play":
                care.sleeping = false;
                care.affection = clamp(care.affection + 6, 0, 100);
                care.energy = clamp(care.energy - 8, 25, 100);
                care.fullness = clamp(care.fullness - 3, 35, 100);
                break;
            case "rest":
                care.sleeping = true;
                break;
            case "wake":
                care.sleeping = false;
                break;
            default:
                throw new BuddyError("invalid_action", `Unknown interaction '${action}'.`);
        }
        if (action !== "wake" && action !== "fling") care.counts[action] = (care.counts[action] || 0) + 1;
        care.last = { type: action, at, origin };
        if (["pet", "feed", "play"].includes(action)) settle(profile);
        commit({ fx: action, origin });
        return { action, mood: deriveMood(care), care: structuredClone(careView(tickCare(care))), treats: profile.treatsEarned - profile.treatsSpent };
    }

    function rename(name) {
        const clean = String(name ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24);
        if (!clean) throw new BuddyError("invalid_name", "Name must contain 1-24 visible characters.");
        load().name = clean;
        commit({ fx: "rename", name: clean });
        return { name: clean };
    }

    /** Equips any unlocked item. Furniture toggles on/off; accessories can be removed with unequip. */
    function equip(itemId, { enabled } = {}) {
        const item = ITEM_BY_ID.get(itemId);
        if (!item) throw new BuddyError("unknown_item", `Unknown item '${itemId}'.`);
        if (!isUnlocked(itemId)) throw new BuddyError("item_locked", `${item.name} is locked. ${describeRequirement(item.req)} to unlock it.`);
        const { appearance } = load();
        if (item.slot === "furniture") {
            const set = new Set(appearance.furniture);
            const on = enabled ?? !set.has(itemId);
            if (on) set.add(itemId);
            else set.delete(itemId);
            appearance.furniture = [...set];
        } else if (ACCESSORY_SLOTS.includes(item.slot) && enabled === false) {
            appearance[item.slot] = null;
        } else {
            appearance[item.slot] = itemId;
        }
        commit({ fx: "equip", itemId, slot: item.slot });
        return { itemId, slot: item.slot, appearance: effectiveAppearance() };
    }

    function unequip(slot) {
        if (!ACCESSORY_SLOTS.includes(slot)) throw new BuddyError("invalid_slot", `Slot must be one of ${ACCESSORY_SLOTS.join(", ")}.`);
        load().appearance[slot] = null;
        commit({ fx: "equip", slot });
        return { slot, appearance: effectiveAppearance() };
    }

    function evolve({ action, type, stage, revision, mode } = {}) {
        const profile = profileOf();
        if (mode !== load().mode || revision !== profile.evolution.revision) throw new BuddyError("evolution_changed", "Evolution changed; refresh and try again.");
        if (!["switch", "select", "upgrade", "reset"].includes(action)) throw new BuddyError("invalid_evolution", "Choose a valid evolution action.");
        if (action !== "reset" && !BUDDIES.some((buddy) => buddy.id === type)) throw new BuddyError("invalid_buddy", "Choose a known buddy type.");
        const before = structuredClone(profile.evolution);
        const celebrations = [...profile.celebrations];
        const evolution = profile.evolution;
        const wallet = evolutionView(evolution, progressOf(profile).xp);
        const line = evolution.buddies[type];
        let fx;
        if (action === "upgrade") {
            const price = wallet.types.find((buddy) => buddy.id === type).stages[line.owned]?.cost;
            if (price === undefined) throw new BuddyError("fully_evolved", "This buddy is fully evolved.");
            if (wallet.balance < price) throw new BuddyError("insufficient_credits", "Earn more XP before buying this evolution.");
            const from = line.owned;
            line.spent += price;
            line.owned++;
            line.selected = line.owned;
            evolution.active = type;
            pushCelebration(profile, { type: "evolution", buddyType: type, stageFrom: from, stageTo: line.owned });
            fx = { fx: "evolution" };
        } else if (action === "select") {
            if (!Number.isInteger(stage) || stage < 1 || stage > line.owned) throw new BuddyError("stage_locked", "Select a stage you own.");
            line.selected = stage;
            evolution.active = type;
        } else if (action === "switch") evolution.active = type;
        else {
            if (!wallet.spent) return { reset: true, refunded: 0 };
            for (const line of Object.values(evolution.buddies)) Object.assign(line, { owned: 1, selected: 1, spent: 0 });
            profile.celebrations = profile.celebrations.filter((event) => event.type !== "evolution");
        }
        evolution.revision++;
        try { commit(fx); }
        catch (error) { profile.evolution = before; profile.celebrations = celebrations; throw error; }
        return { evolution: evolutionView(evolution, progressOf(profile).xp), ...(action === "reset" ? { refunded: wallet.spent } : {}) };
    }

    function setPrefs(prefs) {
        const current = load();
        if (prefs.timeOfDay && ["auto", "day", "night"].includes(prefs.timeOfDay)) current.prefs.timeOfDay = prefs.timeOfDay;
        if (prefs.motion && ["system", "reduced", "full"].includes(prefs.motion)) current.prefs.motion = prefs.motion;
        commit();
        return current.prefs;
    }

    function setMode(mode) {
        if (!["live", "demo"].includes(mode)) throw new BuddyError("invalid_mode", "Mode must be 'live' or 'demo'.");
        load().mode = mode;
        commit({ fx: "mode", mode });
        return { mode };
    }

    function ackCelebrations(ids) {
        const profile = profileOf();
        const set = new Set(ids);
        profile.celebrations = profile.celebrations.filter((celebration) => !set.has(celebration.id));
        save();
        events.emit("change");
    }

    /** Demo-only: fabricates a clearly labelled simulated ticket in the separate demo profile. */
    function simulateDemoTicket(kind = "normal", count = 1) {
        if (!REWARDS[kind] && kind !== "mixed") throw new BuddyError("invalid_kind", "Kind must be normal, hd, critical, or mixed.");
        const current = load();
        if (current.mode !== "demo") throw new BuddyError("demo_mode_required", "Switch to Demo Mode before simulating tickets.");
        const total = clamp(Math.floor(Number(count) || 1), 1, 100);
        const profile = current.profiles.demo;
        const kinds = {};
        let xp = 0;
        const ids = [];
        for (let i = 0; i < total; i++) {
            const ticketKind = kind === "mixed" ? (i % 2 ? "normal" : "hd") : kind;
            profile.demoCounter++;
            const id = `DEMO-${String(profile.demoCounter).padStart(3, "0")}`;
            const reward = REWARDS[ticketKind];
            const reportedAgo = ticketKind === "normal" ? 3 * 86_400_000 : 40 * 60_000;
            profile.ledger[`${SOURCE_DEMO}:${id}`] = {
                id,
                source: SOURCE_DEMO,
                title: `[DEMO] ${DEMO_TITLES[(profile.demoCounter - 1) % DEMO_TITLES.length]}`,
                kind: ticketKind,
                xp: reward.xp,
                status: "rewarded",
                closedOn: nowIso(),
                closedExact: true,
                createdOn: new Date(Date.now() - reportedAgo).toISOString(),
                requester: `DEMO-REQ-${profile.demoCounter % 40}`,
                rewardedAt: nowIso(),
            };
            profile.treatsEarned += reward.treats;
            kinds[ticketKind] = (kinds[ticketKind] || 0) + 1;
            xp += reward.xp;
            ids.push(id);
        }
        invalidate(profile, "tickets");
        pushCelebration(profile, { type: "tickets", count: total, xp, kinds, demo: true });
        const { progress } = settle(profile);
        commit({ fx: "reward", xp, demo: true });
        return { tickets: ids, kinds, xpAwarded: xp, bonusXp: progress.bonusXp, level: progress.level, xp: progress.xp, demo: true };
    }

    function resetDemo() {
        load().profiles.demo = emptyProfile();
        invalidate(load().profiles.demo);
        settle(load().profiles.demo, { quiet: true });
        commit({ fx: "mode", mode: load().mode });
        return { reset: true };
    }

    /**
     * Reconciles verified IT tickets into the live ledger. A ticket's reward is keyed by source + id so it can
     * only ever count once; reopened tickets lose their XP until closed again, but unlocks are kept.
     */
    function applySync({ tickets, complete = false, method = "direct" }) {
        const current = load();
        const profile = current.profiles.live;
        const firstImport = !profile.lastSync;
        const levelBefore = progressOf(profile).level;
        const seen = new Set();
        const summary = { received: tickets.length, newlyRewarded: 0, xpAwarded: 0, reclosed: 0, reopened: 0, skipped: 0, updated: 0, kinds: {} };
        let treats = 0;

        for (const ticket of tickets) {
            if (!ticket.id || (ticket.assignedTo && ticket.assignedTo !== userId)) {
                summary.skipped++;
                continue;
            }
            const key = `${SOURCE_IT}:${ticket.id}`;
            seen.add(key);
            const existing = profile.ledger[key];
            const kind = classifyTicket(ticket);
            const xp = existing?.xp ?? REWARDS[kind].xp;
            const closedOn = ticket.closedOn || existing?.closedOn || ticket.updatedOn || null;
            const details = {
                createdOn: ticket.createdOn ?? existing?.createdOn ?? null,
                requester: ticket.requester ?? existing?.requester ?? null,
                difficulty: ticket.difficulty ?? existing?.difficulty ?? null,
                timesReopened: Math.max(Number(ticket.timesReopened) || 0, Number(existing?.timesReopened) || 0),
                closureChecked: Boolean(existing?.closureChecked || ticket.closureChecked),
            };
            if (!ticket.isOpen) {
                if (!existing) {
                    profile.ledger[key] = { id: ticket.id, source: SOURCE_IT, title: ticket.title, kind, xp, status: "rewarded", closedOn, closedExact: Boolean(ticket.closedOn), ...details, rewardedAt: nowIso() };
                    summary.newlyRewarded++;
                    summary.xpAwarded += xp;
                    summary.kinds[kind] = (summary.kinds[kind] || 0) + 1;
                    treats += REWARDS[kind].treats;
                } else {
                    if (existing.status !== "rewarded") {
                        existing.status = "rewarded";
                        existing.closedOn = ticket.closedOn || ticket.updatedOn || existing.closedOn;
                        delete existing.revokedReason;
                        delete existing.revokedAt;
                        summary.reclosed++;
                        summary.xpAwarded += xp;
                    } else if (existing.kind !== kind || existing.title !== ticket.title || (ticket.closedOn && existing.closedOn !== ticket.closedOn)) {
                        summary.updated++;
                    }
                    Object.assign(existing, { title: ticket.title, kind, xp, closedOn: ticket.closedOn || existing.closedOn, closedExact: existing.closedExact || Boolean(ticket.closedOn), ...details });
                }
            } else if (existing?.status === "rewarded") {
                existing.status = "revoked";
                existing.revokedReason = "reopened";
                existing.revokedAt = parseDate(ticket.updatedOn)?.toISOString() || nowIso();
                Object.assign(existing, details);
                summary.reopened++;
            }
        }
        if (complete) {
            for (const [key, entry] of Object.entries(profile.ledger)) {
                if (entry.source === SOURCE_IT && entry.status === "rewarded" && !seen.has(key)) {
                    entry.status = "revoked";
                    entry.revokedReason = "no longer assigned";
                    entry.revokedAt = nowIso();
                    summary.reopened++;
                }
            }
        }

        invalidate(profile, "tickets");
        profile.treatsEarned += firstImport ? Math.min(treats, INITIAL_IMPORT_TREAT_CAP) : treats;
        if (firstImport && summary.newlyRewarded) {
            pushCelebration(profile, { type: "welcome", tickets: summary.newlyRewarded, xp: summary.xpAwarded, level: levelForXp(progressOf(profile).xp) });
            settle(profile, { quiet: true });
        } else if (profile.rebalancePending) {
            // First sync after the rebalance (with backfilled ticket details): summarize once instead of replaying every unlock.
            if (summary.newlyRewarded || summary.reclosed) {
                pushCelebration(profile, { type: "tickets", count: summary.newlyRewarded + summary.reclosed, xp: summary.xpAwarded, kinds: summary.kinds });
            }
            const { progress } = settle(profile, { quiet: true });
            pushCelebration(profile, {
                type: "rebalance",
                level: progress.level,
                stage: progress.stage,
                bonusXp: progress.bonusXp,
                challenges: progress.challengesCompleted,
                unlocked: profile.unlocked.filter((id) => ITEM_BY_ID.get(id)?.req).length,
                lockable: ITEMS.filter((item) => item.req).length,
            });
            delete profile.rebalancePending;
            delete profile.previousAchievements;
        } else {
            if (summary.newlyRewarded || summary.reclosed) {
                pushCelebration(profile, { type: "tickets", count: summary.newlyRewarded + summary.reclosed, xp: summary.xpAwarded, kinds: summary.kinds });
            }
            settle(profile);
        }
        profile.lastSync = { at: nowIso(), ok: true, method, received: tickets.length, complete };
        profile.lastSyncAttempt = { at: nowIso(), ok: true, error: null, method };
        const progress = progressOf(profile);
        commit((summary.newlyRewarded || summary.reclosed) && current.mode === "live" ? { fx: "reward", xp: summary.xpAwarded } : null);
        return { ...summary, firstImport, levelBefore, level: progress.level, xp: progress.xp, bonusXp: progress.bonusXp, totalClosed: progress.total };
    }

    function applyGitHubSync({ identity, records = [], complete = false, warnings = [], cursor = null, watermark = null, retryAt = null, pauseReason = null, discoveryVersion = null, scopeFingerprint = null }) {
        if (!identity?.login || !Number.isInteger(identity.id)) throw new BuddyError("github_identity", "GitHub did not return a verified identity.");
        const profile = load().profiles.live;
        const gh = profile.github;
        if (gh.identity && (gh.identity.id !== identity.id || gh.identity.host !== identity.host)) throw new BuddyError("github_identity_changed", "GitHub account changed. Sign back into the originally linked account; histories cannot be mixed.");
        const before = progressOf(profile).githubXp;
        const first = !gh.historyInitialized;
        gh.identity = identity;
        for (const record of records) {
            if (!record.id || !record.repo || !record.number) continue;
            const previous = gh.records[record.id];
            if (previous?.updatedAt && record.updatedAt && Date.parse(record.updatedAt) < Date.parse(previous.updatedAt)) continue;
            gh.records[record.id] = record;
        }
        gh.cursor = cursor;
        if (complete) gh.historyInitialized = true;
        delete gh.scopeChanged;
        gh.lastSync = { at: Number.isFinite(Date.parse(watermark)) ? watermark : nowIso(), fetchedAt: nowIso(), complete, discoveryVersion, scopeFingerprint,
            retryAt: Number.isFinite(retryAt) ? retryAt : null, pauseReason: ["rate_limit", "error"].includes(pauseReason) ? pauseReason : null, warnings: warnings.map(String).slice(0, 100) };
        gh.lastAttempt = { at: nowIso(), ok: true, error: null };
        invalidate(profile, "github");
        const progress = progressOf(profile);
        const xpAwarded = progress.githubXp - before;
        if (first) {
            settle(profile, { quiet: true });
            if (xpAwarded > 0) pushCelebration(profile, { type: "github", xp: xpAwarded, count: records.length, historical: true });
        } else {
            if (xpAwarded > 0) pushCelebration(profile, { type: "github", xp: xpAwarded, count: records.length });
            settle(profile);
        }
        commit(load().mode === "live" && xpAwarded > 0 ? { fx: "reward", xp: xpAwarded } : null);
        return { received: records.length, complete, warnings: gh.lastSync.warnings, xpAwarded, githubXp: progress.githubXp, level: progress.level };
    }

    function setGitHubSettings({ enabled, repositories, organizations }) {
        const profile = load().profiles.live;
        if (runtime.githubSyncing) throw new BuddyError("github_busy", "Wait for the current GitHub sync before changing scope.");
        if (enabled !== undefined && typeof enabled !== "boolean") throw new BuddyError("invalid_settings", "enabled must be a boolean.");
        const normalized = (items, regex, name) => {
            if (items === undefined) return undefined;
            if (!Array.isArray(items) || items.length > 100 || items.some((item) => typeof item !== "string" || !regex.test(item))) throw new BuddyError("invalid_scope", "Use at most 100 valid " + name + ".");
            return [...new Set(items.map((item) => item.toLowerCase()))].sort();
        };
        const repos = normalized(repositories, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/repository names");
        const orgs = normalized(organizations, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, "organization names");
        const settings = profile.github.settings;
        const changed = JSON.stringify(repos ?? settings.repositories) !== JSON.stringify(settings.repositories) || JSON.stringify(orgs ?? settings.organizations) !== JSON.stringify(settings.organizations);
        if (enabled !== undefined) settings.enabled = enabled;
        if (repos) settings.repositories = repos;
        if (orgs) settings.organizations = orgs;
        settings.needsScope = !settings.repositories.length && !settings.organizations.length;
        if (changed) {
            profile.github.cursor = null;
            if (profile.github.lastSync) profile.github.lastSync = { ...profile.github.lastSync, complete: false, scopeFingerprint: null, warnings: ["Scope changed; refresh manually. Earned history retained."] };
            profile.github.scopeChanged = true;
            progressCache.delete(profile);
        }
        commit();
        return structuredClone(settings);
    }

    function recordGitHubFailure(message, { retryAt = null, pauseReason = null } = {}) {
        load().profiles.live.github.lastAttempt = { at: nowIso(), ok: false, error: String(message).slice(0, 300),
            retryAt: Number.isFinite(retryAt) ? retryAt : null, pauseReason: ["rate_limit", "error"].includes(pauseReason) ? pauseReason : null };
        commit();
    }

    function recordSyncFailure(message, method) {
        const profile = load().profiles.live;
        profile.lastSyncAttempt = { at: nowIso(), ok: false, error: String(message).slice(0, 300), method };
        commit();
    }

    function setRuntime(patch) {
        Object.assign(runtime, patch);
        events.emit("change");
    }

    const ledgerEntry = (ticketId) => load().profiles.live.ledger[`${SOURCE_IT}:${ticketId}`];

    return {
        events,
        file,
        legacyFile,
        analytics,
        exportRollback: () => storage.exportState(load()),
        exportState: () => { const { storage: metadata, ...current } = load(); return structuredClone(current); },
        // Legacy callers may edit the returned state; invalidate before handing it out.
        load: () => {
            const current = load();
            for (const profile of Object.values(current.profiles)) invalidate(profile);
            return current;
        },
        view,
        interact,
        rename,
        equip,
        unequip,
        evolve,
        setPrefs,
        setMode,
        ackCelebrations,
        simulateDemoTicket,
        resetDemo,
        applySync,
        applyGitHubSync,
        setGitHubSettings,
        recordGitHubFailure,
        recordSyncFailure,
        setRuntime,
        runtime,
        ledgerEntry: (ticketId) => {
            invalidate(load().profiles.live);
            return ledgerEntry(ticketId);
        },
        catalog,
        moods: MOODS,
    };
}
