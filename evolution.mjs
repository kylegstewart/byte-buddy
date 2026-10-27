import { ECONOMY } from "./economy.mjs";

export const BUDDIES = [
    { id: "robot", name: "Robot", stages: ["Sprout Bot", "Buddy Bot", "Beacon Bot", "Turbo Bot", "Stellar Bot"] },
    { id: "cat", name: "Cat", stages: ["Kitten", "Cat", "Scout Cat", "Moon Cat", "Celestial Cat"] },
    { id: "dog", name: "Dog", stages: ["Puppy", "Dog", "Trail Dog", "Guardian Dog", "Stellar Hound"] },
    { id: "dragon", name: "Dragon", stages: ["Hatchling", "Wyrmling", "Drake", "Sky Dragon", "Elder Dragon"] },
    { id: "slime", name: "Slime", stages: ["Droplet", "Slime", "Bloom Slime", "Prism Slime", "Cosmic Slime"] },
];
export const evolutionCredit = (stage) => ECONOMY.evolution.costs.slice(0, stage - 1).reduce((sum, cost) => sum + cost, 0);
export function newEvolution(xp = 0, legacyStage = 1) {
    return { version: 1, revision: 0, active: "robot", xp, legacyCredit: evolutionCredit(legacyStage), legacyStage,
        buddies: Object.fromEntries(BUDDIES.map(({ id }) => [id, { owned: 1, selected: 1, spent: 0 }])) };
}
export function evolutionView(evolution, xp) {
    const spent = Object.values(evolution.buddies).reduce((sum, line) => sum + line.spent, 0);
    const balance = xp + evolution.legacyCredit - spent;
    const active = evolution.buddies[evolution.active];
    const type = BUDDIES.find(({ id }) => id === evolution.active);
    return { ...evolution, xp, spent, balance, available: Math.max(0, balance), deficit: Math.max(0, -balance),
        stage: active.selected, owned: active.owned, stageName: type.stages[active.selected - 1],
        nextCost: ECONOMY.evolution.costs[active.owned - 1] ?? null,
        types: BUDDIES.map((type) => ({ ...type, stages: type.stages.map((name, index) => ({ stage: index + 1, name, cost: index ? ECONOMY.evolution.costs[index - 1] : 0 })) })) };
}
