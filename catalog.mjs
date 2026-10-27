// Static game data: rewards, level curve, evolution stages, achievements, and customization items.

import { ECONOMY } from "./economy.mjs";
import { GITHUB_ACHIEVEMENTS, GITHUB_CHALLENGES } from "./github.mjs";

export const SOURCE_IT = "information-technology";
export const SOURCE_DEMO = "demo";

export const REWARDS = {
    normal: { xp: 100, treats: 1, label: "Ticket closed" },
    hd: { xp: 200, treats: 2, label: "Help Desk issue resolved" },
    critical: { xp: 400, treats: 3, label: "Critical production issue resolved" },
};

// Phase 2 adds GitHub income; migration credits preserve existing level progress.
const LEVEL_BASE = ECONOMY.levels.base;
const LEVEL_STEP = ECONOMY.levels.step;

/** XP needed to go from level L to L + 1. */
export const levelCost = (level) => LEVEL_BASE + LEVEL_STEP * (level - 1);

/** Cumulative XP required to reach `level`. */
export function xpForLevel(level) {
    const n = level - 1;
    return LEVEL_BASE * n + (LEVEL_STEP * n * (n - 1)) / 2;
}

export function levelForXp(xp) {
    let level = 1;
    while (xpForLevel(level + 1) <= xp) level++;
    return level;
}

export const STAGES = [
    { stage: 1, level: 1, name: "Sprout Bot", blurb: "A tiny robot on a single wheel." },
    { stage: 2, level: 5, name: "Buddy Bot", blurb: "Taller, with legs and bigger, more expressive eyes." },
    { stage: 3, level: 15, name: "Beacon Bot", blurb: "Glowing antenna, cheek lights, and shoulder pads." },
    { stage: 4, level: 30, name: "Turbo Bot", blurb: "Armor plating, a glowing power core, and jet boosters." },
    { stage: 5, level: 45, name: "Stellar Bot", blurb: "Gold trim and an orbiting aura of sparkles." },
];

export const stageForLevel = (level) => STAGES.reduce((stage, entry) => (level >= entry.level ? entry.stage : stage), 1);

export const ACHIEVEMENTS = [
    { id: "first-fix", name: "First Fix", description: "Close your first ticket.", rewards: ["hat-beanie", "furn-duck"] },
    { id: "getting-started", name: "Getting Started", description: "Close 10 tickets.", rewards: ["hat-propeller", "furn-trophy"] },
    { id: "bug-hunter", name: "Bug Hunter", description: "Resolve 25 Help Desk issues.", rewards: ["neck-bugbadge", "furn-bugjar"] },
    { id: "firefighter", name: "Firefighter", description: "Resolve a critical production issue.", rewards: ["hat-helmet"] },
    { id: "on-a-roll", name: "On a Roll", description: "Close tickets on 5 consecutive working days.", rewards: ["glasses-shades"] },
    { id: "centurion", name: "Centurion", description: "Close 100 tickets.", rewards: ["phones-classic"] },
    { id: "challenger", name: "Challenger", description: "Complete 10 different challenges.", rewards: ["furn-arcade"] },
    { id: "exterminator", name: "Exterminator", description: "Resolve 250 Help Desk issues.", rewards: ["eye-violet"] },
    { id: "ticket-titan", name: "Ticket Titan", description: "Close 500 tickets.", rewards: ["room-space"] },
    { id: "veteran", name: "Veteran Developer", description: "Reach level 40.", rewards: ["neck-star"] },
    { id: "legend", name: "Living Legend", description: "Close 1,000 tickets.", rewards: ["hat-crown", "body-gold"] },
    { id: "warming-up", name: "Warming Up", description: "Close 50 tickets.", rewards: ["furn-lights"] },
    { id: "on-call", name: "On Call", description: "Resolve 50 Help Desk issues.", rewards: ["hat-headset"] },
    { id: "networker", name: "Networker", description: "Close tickets for 50 different requesters.", rewards: ["neck-lanyard"] },
    { id: "sleuth", name: "Sleuth", description: "Discover 3 secret challenges.", rewards: ["glasses-monocle"] },
    { id: "quarter-grand", name: "Quarter Grand", description: "Close 250 tickets.", rewards: ["neck-medal"] },
    { id: "best-friends", name: "Best Friends", description: "Pet your buddy 100 times.", rewards: ["glasses-hearts", "furn-cat"] },
    { id: "snack-attack", name: "Snack Attack", description: "Feed your buddy 25 treats.", rewards: ["furn-beanbag"] },
    { id: "playmate", name: "Playmate", description: "Play with your buddy 50 times.", rewards: ["furn-boombox"] },
    { id: "speed-demon", name: "Speed Demon", description: "Earn 50 Speedrun bonuses.", rewards: ["glasses-goggles"] },
    { id: "triple-threat", name: "Triple Threat", description: "Earn 50 Hat Trick bonuses.", rewards: ["hat-tophat"] },
    { id: "high-roller", name: "High Roller", description: "Earn 10 High Five bonuses.", rewards: ["furn-disco"] },
    { id: "relic-hunter", name: "Relic Hunter", description: "Earn 30 Archaeologist bonuses.", rewards: ["hat-explorer"] },
    { id: "marathoner", name: "Marathoner", description: "Earn 6 Monthly Marathon bonuses.", rewards: ["wall-racing"] },
    { id: "same-day-pro", name: "Same-Day Pro", description: "Earn 300 Same-Day Save bonuses.", rewards: ["phones-dj"] },
    { id: "unstoppable", name: "Unstoppable", description: "Close tickets on 10 consecutive working days.", rewards: ["neck-cape"] },
    { id: "iron-will", name: "Iron Will", description: "Close tickets on 20 consecutive working days.", rewards: ["hat-viking"] },
    { id: "completionist", name: "Completionist", description: "Complete 20 different challenges.", rewards: ["body-holo"] },
    { id: "master-detective", name: "Master Detective", description: "Discover every secret challenge.", rewards: ["hat-detective"] },
    { id: "socialite", name: "Socialite", description: "Close tickets for 150 different requesters.", rewards: ["furn-clock"] },
    { id: "three-quarters", name: "Three-Quarter Mark", description: "Close 750 tickets.", rewards: ["room-cabin"] },
    { id: "help-desk-hero", name: "Help Desk Hero", description: "Resolve 500 Help Desk issues.", rewards: ["hat-halo"] },
    { id: "maxed-out", name: "Maxed Out", description: "Reach level 50.", rewards: ["neck-chain", "eye-gold"] },
];

const careAchievements = new Set(["best-friends", "snack-attack", "playmate"]);
const overallAchievements = new Set(["veteran", "maxed-out", "challenger", "completionist"]);
const silverAchievements = new Set(["bug-hunter", "on-a-roll", "centurion", "warming-up", "on-call", "networker", "sleuth", "best-friends", "snack-attack", "playmate", "unstoppable"]);
const goldAchievements = new Set(["quarter-grand", "exterminator", "ticket-titan", "veteran", "completionist", "master-detective", "socialite", "iron-will", "marathoner", "speed-demon", "triple-threat", "high-roller", "relic-hunter", "same-day-pro"]);
const platinumAchievements = new Set(["legend", "three-quarters", "help-desk-hero", "maxed-out"]);
for (const achievement of ACHIEVEMENTS) {
    achievement.category = careAchievements.has(achievement.id) ? "care" : overallAchievements.has(achievement.id) ? "overall" : "ticket";
    achievement.tier = platinumAchievements.has(achievement.id) ? "Platinum" : goldAchievements.has(achievement.id) ? "Gold" : silverAchievements.has(achievement.id) ? "Silver" : "Bronze";
}
ACHIEVEMENTS.push(
    ...[
        ["development", "Development Builder", "normal", [25, 100, 250], "Close", "standard development tickets"],
        ["critical", "Production Guardian", "critical", [5, 25, 100], "Resolve", "critical production issues"],
        ["difficult", "Problem Solver", "difficult", [5, 25, 100], "Close", "tickets rated difficulty 3 or higher"],
    ].flatMap(([id, name, metric, targets, verb, subject]) => targets.map((target, i) => ({
        id: `ticket-${id}-${target}`, name: `${name} ${["I", "II", "III"][i]}`, description: `${verb} ${target} ${subject}.`,
        metric, target, tier: ["Bronze", "Silver", "Gold"][i], category: "ticket", rewards: [],
    }))),
    { id: "ticket-community-250", name: "Community Champion", description: "Close tickets for 250 distinct requesters.", metric: "requesters", target: 250, tier: "Platinum", category: "ticket", rewards: [] },
);

// Requirement shapes: { level } | { achievement } | { hd } | null (always available).
export const ITEMS = [
    { id: "body-teal", slot: "bodyColor", name: "Teal", color: "#3fb8af", req: null },
    { id: "body-sky", slot: "bodyColor", name: "Sky", color: "#5aa9e6", req: null },
    { id: "body-mint", slot: "bodyColor", name: "Mint", color: "#7bd389", req: { level: 4 } },
    { id: "body-sunset", slot: "bodyColor", name: "Sunset", color: "#f28f3b", req: { level: 10 } },
    { id: "body-lavender", slot: "bodyColor", name: "Lavender", color: "#a594f9", req: { level: 22 } },
    { id: "body-rose", slot: "bodyColor", name: "Rose", color: "#ef798a", req: { hd: 100 } },
    { id: "body-graphite", slot: "bodyColor", name: "Graphite", color: "#7d8590", req: { level: 33 } },
    { id: "body-gold", slot: "bodyColor", name: "Gold", color: "#e9b949", req: { achievement: "legend" } },
    { id: "body-cherry", slot: "bodyColor", name: "Cherry", color: "#e05a5a", req: { level: 13 } },
    { id: "body-ocean", slot: "bodyColor", name: "Ocean", color: "#2f7fbf", req: { level: 26 } },
    { id: "body-forest", slot: "bodyColor", name: "Forest", color: "#4f9d69", req: { level: 36 } },
    { id: "body-bubblegum", slot: "bodyColor", name: "Bubblegum", color: "#ff8fc8", req: { hd: 300 } },
    { id: "body-obsidian", slot: "bodyColor", name: "Obsidian", color: "#3b3f4a", req: { level: 47 } },
    { id: "body-holo", slot: "bodyColor", name: "Holo", color: "#9fe7f5", req: { achievement: "completionist" } },

    { id: "eye-cyan", slot: "eyeColor", name: "Cyan", color: "#7cf8ff", req: null },
    { id: "eye-amber", slot: "eyeColor", name: "Amber", color: "#ffcf56", req: { level: 2 } },
    { id: "eye-lime", slot: "eyeColor", name: "Lime", color: "#b8f35d", req: { level: 7 } },
    { id: "eye-pink", slot: "eyeColor", name: "Pink", color: "#ff9ecf", req: { level: 24 } },
    { id: "eye-violet", slot: "eyeColor", name: "Violet", color: "#c9a7ff", req: { achievement: "exterminator" } },
    { id: "eye-ember", slot: "eyeColor", name: "Ember", color: "#ff6b6b", req: { level: 11 } },
    { id: "eye-ice", slot: "eyeColor", name: "Ice", color: "#dff6ff", req: { level: 19 } },
    { id: "eye-gold", slot: "eyeColor", name: "Gold", color: "#ffd700", req: { achievement: "maxed-out" } },

    { id: "variant-classic", slot: "variant", name: "Classic", req: null },
    { id: "variant-boxy", slot: "variant", name: "Retro Boxy", req: { level: 16 } },
    { id: "variant-bubble", slot: "variant", name: "Bubble", req: { level: 40 } },

    { id: "hat-beanie", slot: "hat", name: "Cozy Beanie", req: { achievement: "first-fix" } },
    { id: "hat-party", slot: "hat", name: "Party Hat", req: { level: 6 } },
    { id: "hat-propeller", slot: "hat", name: "Propeller Cap", req: { achievement: "getting-started" } },
    { id: "hat-helmet", slot: "hat", name: "Fire Helmet", req: { achievement: "firefighter" } },
    { id: "hat-wizard", slot: "hat", name: "Wizard Hat", req: { level: 42 } },
    { id: "hat-crown", slot: "hat", name: "Crown", req: { achievement: "legend" } },
    { id: "hat-headset", slot: "hat", name: "Support Headset", req: { achievement: "on-call" } },
    { id: "hat-chef", slot: "hat", name: "Chef's Toque", req: { level: 21 } },
    { id: "hat-cowboy", slot: "hat", name: "Cowboy Hat", req: { level: 27 } },
    { id: "hat-tophat", slot: "hat", name: "Top Hat", req: { achievement: "triple-threat" } },
    { id: "hat-explorer", slot: "hat", name: "Explorer Fedora", req: { achievement: "relic-hunter" } },
    { id: "hat-viking", slot: "hat", name: "Viking Helmet", req: { achievement: "iron-will" } },
    { id: "hat-detective", slot: "hat", name: "Deerstalker", req: { achievement: "master-detective" } },
    { id: "hat-pirate", slot: "hat", name: "Pirate Tricorn", req: { level: 44 } },
    { id: "hat-halo", slot: "hat", name: "Halo", req: { achievement: "help-desk-hero" } },

    { id: "glasses-round", slot: "glasses", name: "Round Specs", req: { level: 3 } },
    { id: "glasses-shades", slot: "glasses", name: "Cool Shades", req: { achievement: "on-a-roll" } },
    { id: "glasses-visor", slot: "glasses", name: "Cyber Visor", req: { level: 30 } },
    { id: "glasses-3d", slot: "glasses", name: "3D Glasses", req: { level: 17 } },
    { id: "glasses-monocle", slot: "glasses", name: "Monocle", req: { achievement: "sleuth" } },
    { id: "glasses-hearts", slot: "glasses", name: "Heart Glasses", req: { achievement: "best-friends" } },
    { id: "glasses-goggles", slot: "glasses", name: "Racing Goggles", req: { achievement: "speed-demon" } },

    { id: "phones-classic", slot: "headphones", name: "Headphones", req: { achievement: "centurion" } },
    { id: "phones-cat", slot: "headphones", name: "Cat-Ear Headphones", req: { level: 37 } },
    { id: "phones-earmuffs", slot: "headphones", name: "Fluffy Earmuffs", req: { level: 23 } },
    { id: "phones-dj", slot: "headphones", name: "Neon DJ Cans", req: { achievement: "same-day-pro" } },

    { id: "neck-bowtie", slot: "neck", name: "Bow Tie", req: { level: 8 } },
    { id: "neck-scarf", slot: "neck", name: "Scarf", req: { level: 20 } },
    { id: "neck-bugbadge", slot: "neck", name: "Bug Badge", req: { achievement: "bug-hunter" } },
    { id: "neck-star", slot: "neck", name: "Star Pin", req: { achievement: "veteran" } },
    { id: "neck-tie", slot: "neck", name: "Necktie", req: { level: 12 } },
    { id: "neck-lanyard", slot: "neck", name: "ID Lanyard", req: { achievement: "networker" } },
    { id: "neck-medal", slot: "neck", name: "Medal", req: { achievement: "quarter-grand" } },
    { id: "neck-bandana", slot: "neck", name: "Bandana", req: { level: 31 } },
    { id: "neck-cape", slot: "neck", name: "Hero Cape", req: { achievement: "unstoppable" } },
    { id: "neck-chain", slot: "neck", name: "Gold Chain", req: { achievement: "maxed-out" } },

    { id: "wall-cream", slot: "wall", name: "Cream", color: "#f3e9d2", req: null },
    { id: "wall-sage", slot: "wall", name: "Sage", color: "#cfe3c8", req: { level: 5 } },
    { id: "wall-dusk", slot: "wall", name: "Dusk Blue", color: "#c6d4f0", req: { level: 15 } },
    { id: "wall-peach", slot: "wall", name: "Peach", color: "#f8d5c4", req: { level: 28 } },
    { id: "wall-midnight", slot: "wall", name: "Midnight", color: "#4b4a72", req: { level: 48 } },
    { id: "wall-lemon", slot: "wall", name: "Lemon", color: "#f7eeb0", req: { level: 14 } },
    { id: "wall-mint", slot: "wall", name: "Seafoam", color: "#d2efe6", req: { hd: 150 } },
    { id: "wall-brick", slot: "wall", name: "Terracotta", color: "#c98a73", req: { level: 38 } },
    { id: "wall-racing", slot: "wall", name: "Racing Green", color: "#2f5d50", req: { achievement: "marathoner" } },

    { id: "room-cozy", slot: "room", name: "Cozy Room", req: null },
    { id: "room-server", slot: "room", name: "Server Room", req: { level: 18 } },
    { id: "room-garden", slot: "room", name: "Garden Patio", req: { level: 45 } },
    { id: "room-space", slot: "room", name: "Space Station", req: { achievement: "ticket-titan" } },
    { id: "room-beach", slot: "room", name: "Beach Hut", req: { level: 32 } },
    { id: "room-arcade", slot: "room", name: "Neon Arcade", req: { level: 41 } },
    { id: "room-cabin", slot: "room", name: "Log Cabin", req: { achievement: "three-quarters" } },

    { id: "furn-plant", slot: "furniture", name: "Potted Plant", req: null },
    { id: "furn-rug", slot: "furniture", name: "Round Rug", req: { level: 4 } },
    { id: "furn-shelf", slot: "furniture", name: "Bookshelf", req: { level: 9 } },
    { id: "furn-lamp", slot: "furniture", name: "Floor Lamp", req: { level: 12 } },
    { id: "furn-arcade", slot: "furniture", name: "Arcade Cabinet", req: { achievement: "challenger" } },
    { id: "furn-tank", slot: "furniture", name: "Fish Tank", req: { level: 35 } },
    { id: "furn-duck", slot: "furniture", name: "Rubber Duck", req: { achievement: "first-fix" } },
    { id: "furn-trophy", slot: "furniture", name: "Trophy Shelf", req: { achievement: "getting-started" } },
    { id: "furn-bugjar", slot: "furniture", name: "Bug Jar", req: { achievement: "bug-hunter" } },
    { id: "furn-lights", slot: "furniture", name: "Fairy Lights", req: { achievement: "warming-up" } },
    { id: "furn-poster", slot: "furniture", name: "Mountain Poster", req: { level: 25 } },
    { id: "furn-neon", slot: "furniture", name: "Neon Code Sign", req: { level: 46 } },
    { id: "furn-clock", slot: "furniture", name: "Wall Clock", req: { achievement: "socialite" } },
    { id: "furn-disco", slot: "furniture", name: "Disco Ball", req: { achievement: "high-roller" } },
    { id: "furn-cat", slot: "furniture", name: "Napping Cat", req: { achievement: "best-friends" } },
    { id: "furn-beanbag", slot: "furniture", name: "Beanbag", req: { achievement: "snack-attack" } },
    { id: "furn-boombox", slot: "furniture", name: "Boombox", req: { achievement: "playmate" } },
];

/**
 * Bonus XP challenges, evaluated from the ticket ledger. `repeat` controls how often a challenge pays out:
 * "day" / "week" / "month" once per qualifying period, "ticket" once per qualifying ticket, "once" a single time.
 * Secret challenges stay hidden in the UI until discovered.
 */
export const CHALLENGES = [
    { id: "hat-trick", name: "Hat Trick", description: "Close 3 tickets in one day.", xp: 150, treats: 1, repeat: "day" },
    { id: "high-five", name: "High Five", description: "Close 5 tickets in one day.", xp: 750, treats: 2, repeat: "day" },
    { id: "perfect-ten", name: "Perfect Ten", description: "Close 10 tickets in one day.", xp: 2500, treats: 5, repeat: "day" },
    { id: "hd-blitz", name: "Help Desk Blitz", description: "Resolve 3 Help Desk issues in one day.", xp: 300, treats: 1, repeat: "day" },
    { id: "full-week", name: "Full Week", description: "Close a ticket every weekday, Monday through Friday.", xp: 500, treats: 2, repeat: "week" },
    { id: "monthly-marathon", name: "Monthly Marathon", description: "Close 25 tickets in one calendar month.", xp: 1000, treats: 3, repeat: "month" },
    { id: "same-day-save", name: "Same-Day Save", description: "Resolve a Help Desk issue on the day it was reported.", xp: 25, treats: 0, repeat: "ticket" },
    { id: "speedrun", name: "Speedrun", description: "Resolve a Help Desk issue within an hour of it being reported.", xp: 75, treats: 0, repeat: "ticket" },
    { id: "archaeologist", name: "Archaeologist", description: "Close a ticket that was open for over a year.", xp: 200, treats: 1, repeat: "ticket" },
    { id: "boss-fight", name: "Boss Fight", description: "Close a ticket rated difficulty 3 or higher.", xp: 300, treats: 1, repeat: "ticket" },
    { id: "friendly-face", name: "Friendly Face", description: "Close tickets for 10 different requesters.", xp: 250, treats: 1, repeat: "once" },
    { id: "people-person", name: "People Person", description: "Close tickets for 25 different requesters.", xp: 500, treats: 2, repeat: "once" },
    { id: "office-hero", name: "Office Hero", description: "Close tickets for 50 different requesters.", xp: 1000, treats: 3, repeat: "once" },
    { id: "company-legend", name: "Company Legend", description: "Close tickets for 100 different requesters.", xp: 2000, treats: 5, repeat: "once" },
    { id: "palindrome", name: "Palindrome", description: "Close a ticket whose number reads the same backwards.", xp: 500, treats: 2, repeat: "once", secret: true },
    { id: "lucky-sevens", name: "Lucky Sevens", description: "Close a ticket whose number ends in 777.", xp: 777, treats: 3, repeat: "once", secret: true },
    { id: "leet", name: "1337 h4x0r", description: "Close a ticket whose number contains 1337.", xp: 1337, treats: 3, repeat: "once", secret: true },
    { id: "round-number", name: "Round Number", description: "Close a ticket whose number ends in 000.", xp: 1000, treats: 3, repeat: "once", secret: true },
    { id: "pi-day", name: "Pi Day", description: "Close a ticket on March 14.", xp: 314, treats: 2, repeat: "once", secret: true },
    { id: "friday-13", name: "Friday the 13th", description: "Close a ticket on a Friday the 13th.", xp: 666, treats: 2, repeat: "once", secret: true },
    { id: "holiday-hero", name: "Holiday Hero", description: "Close a ticket on New Year's Day, July 4th, Christmas Eve, Christmas, or New Year's Eve.", xp: 500, treats: 3, repeat: "once", secret: true },
    { id: "weekend-warrior", name: "Weekend Warrior", description: "Close a ticket on a Saturday or Sunday.", xp: 250, treats: 2, repeat: "once", secret: true },
    { id: "night-owl", name: "Night Owl", description: "Close a ticket between 8 PM and 5 AM.", xp: 250, treats: 2, repeat: "once", secret: true },
    { id: "early-bird", name: "Early Bird", description: "Close a ticket between 5 AM and 7 AM.", xp: 250, treats: 2, repeat: "once", secret: true },
    { id: "note-to-self", name: "Note to Self", description: "Close a ticket you reported yourself.", xp: 100, treats: 1, repeat: "once", secret: true },
    { id: "second-wind", name: "Second Wind", description: "Close a ticket after it was reopened.", xp: 150, treats: 1, repeat: "once", secret: true },
    { id: "development-ten", name: "Development Momentum", description: "Close 10 standard development tickets.", xp: 200, treats: 1, repeat: "once" },
    { id: "support-ten", name: "Support Foundation", description: "Resolve 10 Help Desk issues.", xp: 250, treats: 1, repeat: "once" },
    { id: "critical-five", name: "Production Protector", description: "Resolve 5 critical production issues.", xp: 400, treats: 2, repeat: "once" },
    { id: "problem-solver", name: "Problem Solver", description: "Close 10 tickets rated difficulty 3 or higher.", xp: 300, treats: 1, repeat: "once" },
    { id: "monthly-network", name: "Monthly Outreach", description: "Close tickets for 5 distinct requesters in a calendar month.", xp: 200, treats: 1, repeat: "month" },
    { id: "versatile-month", name: "Versatile Developer", description: "Close 5 standard development tickets and resolve 5 Help Desk issues in a calendar month.", xp: 300, treats: 1, repeat: "month" },
];

for (const challenge of CHALLENGES) challenge.category = "ticket";
ACHIEVEMENTS.push(...GITHUB_ACHIEVEMENTS);
CHALLENGES.push(...GITHUB_CHALLENGES);
ITEMS.push(
    { id: "body-github", slot: "bodyColor", name: "Merge Violet", color: "#6e40c9", req: { achievement: "gh-merge-1" } },
    { id: "eye-review", slot: "eyeColor", name: "Review Spark", color: "#a5f3bc", req: { achievement: "gh-review-25" } },
    { id: "wall-quality", slot: "wall", name: "Quality Garden", color: "#c8e6df", req: { achievement: "gh-clean-10" } },
);

export const CHALLENGE_BY_ID = new Map(CHALLENGES.map((challenge) => [challenge.id, challenge]));

export const ITEM_BY_ID = new Map(ITEMS.map((item) => [item.id, item]));
export const ACCESSORY_SLOTS = ["hat", "glasses", "headphones", "neck"];

export const DEFAULT_APPEARANCE = {
    bodyColor: "body-teal",
    eyeColor: "eye-cyan",
    variant: "variant-classic",
    hat: null,
    glasses: null,
    headphones: null,
    neck: null,
    wall: "wall-cream",
    room: "room-cozy",
    furniture: ["furn-plant"],
};

export function describeRequirement(req) {
    if (!req) return "Available from the start";
    if (req.level) return `Reach level ${req.level}`;
    if (req.hd) return `Resolve ${req.hd} Help Desk issues`;
    if (req.achievement) return `Achievement: ${ACHIEVEMENTS.find((a) => a.id === req.achievement)?.name ?? req.achievement}`;
    return "Unknown";
}

export function meetsRequirement(req, { level, hdCount, achievements }) {
    if (!req) return true;
    if (req.level) return level >= req.level;
    if (req.hd) return hdCount >= req.hd;
    if (req.achievement) return Boolean(achievements[req.achievement]);
    return false;
}

export const DEMO_TITLES = [
    "Fix rounding on invoice totals",
    "Add export button to RGA grid",
    "Pick list prints blank second page",
    "Update vendor price controls screen",
    "Drop-ship PO link returns error",
    "Speed up inventory lookup query",
    "Will Call screen freezes on scan",
    "Add warehouse filter to report",
    "Customer portal login loop",
    "Missing purchasing category levels",
];
