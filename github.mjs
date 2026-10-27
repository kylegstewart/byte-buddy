import { ECONOMY } from './economy.mjs';

const DAY = 86400000;
const dateMs = (v) => Date.parse(v || '');
const validDate = (v) => Number.isFinite(dateMs(v));
export const utcDay = (v) => new Date(v).toISOString().slice(0, 10);
export function utcWeek(value) {
    const d = new Date(`${utcDay(value)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return utcDay(d);
}
const loginIs = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
const human = (name, type) => Boolean(name) && type !== 'Bot' && !/\[bot\]$|^copilot$|^coderabbitai$/i.test(name);
const actionText = (text) => /```suggestion|\b(please|should|must|fix|incorrect|bug|missing|consider|prevent|avoid|replace|instead|could you)\b/i.test(text || '');
const botFinding = (text) => /(?:_?⚠️?\s*Potential issue|🛑|🔴|🟠|🟡|\b(?:critical|major|minor)\b.{0,35}\b(?:issue|severity)|\*\*(?:issue|bug|security|actionable))/i.test(text || '');
const informational = (text) => /^(?:lgtm[.! ]*|thanks[.! ]*|thank you[.! ]*|nice[.! ]*|looks good[.! ]*)$/i.test(String(text || '').trim());

export const GITHUB_CHALLENGES = [
    ['gh-daily', 'Daily Collaborator', 'Complete a meaningful review in a UTC day.', 'day', 1, 'daily'],
    ['gh-merge-master', 'Merge Master', 'Have 5 meaningful authored PRs merged in a UTC week, by anyone.', 'week', 5, 'mergeWeek'],
    ['gh-quality-first', 'Quality First', 'Have 3 authored PRs merged with verified clean reviews.', 'once', 3, 'quality'],
    ['gh-helping-hand', 'Helping Hand', 'Complete 5 meaningful reviews of other developers’ PRs.', 'once', 5, 'reviews'],
    ['gh-review-champion', 'Review Champion', 'Give constructive review feedback on 10 different PRs.', 'once', 10, 'constructive'],
    ['gh-clean-streak', 'Clean Code Streak', 'Have 3 consecutive authored PRs merged with verified clean reviews.', 'once', 3, 'cleanStreak'],
    ['gh-consistent', 'Consistent Contributor', 'Have authored PRs merged in 4 consecutive UTC weeks.', 'once', 4, 'consistency'],
    ['gh-improvement', 'Quality Improvement', 'Reduce findings per 100 changed lines by 20% across two consecutive groups of 5 reviewed authored merges.', 'once', 1, 'improvement'],
    ['gh-balanced', 'Balanced Developer', 'Earn 200 ticket XP and 200 GitHub contribution XP in a UTC month.', 'month', 200, 'balanced'],
    ['gh-focused', 'Small & Focused', 'Have 5 focused authored PRs merged, of 5–400 changed lines and at most 10 files.', 'once', 5, 'focused'],
    ['gh-team', 'Team Player', 'Have 3 authored PRs merged and review 3 other developers’ PRs in a UTC month.', 'month', 3, 'team'],
    ['gh-test-builder', 'Test Builder', 'Have 10 meaningful authored PRs merged with verified test-file changes.', 'once', 10, 'tests'],
    ['gh-documentarian', 'Documentarian', 'Have 5 meaningful authored PRs merged with verified documentation changes.', 'once', 5, 'documentation'],
    ['gh-feedback-partner', 'Feedback Partner', 'Have constructive feedback explicitly acknowledged by the author on 5 PRs.', 'once', 5, 'helpful'],
    ['gh-release-steward', 'Release Steward', 'Personally merge 5 other developers’ meaningful PRs with verified human review decisions.', 'once', 5, 'release'],
    ['gh-review-rhythm', 'Review Rhythm', 'Review other developers’ PRs in 4 consecutive UTC weeks.', 'once', 4, 'reviewWeeks'],
    ['gh-repository-bridge', 'Repository Bridge', 'Have meaningful authored merges or reviews in 3 repositories.', 'once', 3, 'repositories'],
].map(([id, name, description, repeat, target, rule]) => ({ id, name, description, repeat, target, rule, xp: ECONOMY.github.challenges[rule], treats: repeat === 'day' ? 0 : 1, category: 'github' }));

export const GITHUB_ACHIEVEMENTS = [
    ...[1, 10, 25, 50, 100, 250].map((n, i) => ({ id: `gh-merge-${n}`, name: `${['First Merge', 'Merge Builder', 'Merge Artisan', 'Merge Expert', 'Merge Master', 'Merge Legend'][i]}`, description: `Have ${n} meaningful authored PR${n === 1 ? '' : 's'} merged, by anyone.`, metric: 'authoredMerged', target: n, tier: ['Bronze', 'Bronze', 'Silver', 'Gold', 'Gold', 'Platinum'][i], rewards: n === 1 ? ['body-github'] : [] })),
    ...[1, 25, 50, 100].map((n, i) => ({ id: `gh-review-${n}`, name: `Review ${['Initiate', 'Ally', 'Champion', 'Luminary'][i]}`, description: `Complete ${n} meaningful reviews of other developers’ PRs.`, metric: 'reviewed', target: n, tier: ['Bronze', 'Silver', 'Gold', 'Platinum'][i], rewards: n === 25 ? ['eye-review'] : [] })),
    ...[5, 25, 50].map((n, i) => ({ id: `gh-helpful-${n}`, name: `Helpful Reviewer ${['I', 'II', 'III'][i]}`, description: `Have actionable feedback explicitly acknowledged by the PR author on ${n} PRs.`, metric: 'helpful', target: n, tier: ['Bronze', 'Silver', 'Gold'][i], rewards: [] })),
    { id: 'gh-clean-10', name: 'Quality Guardian', description: 'Have 10 authored PRs merged with verified clean reviews.', metric: 'clean', target: 10, tier: 'Gold', rewards: ['wall-quality'] },
    { id: 'gh-low-defect', name: 'Review Ready', description: 'Have 10 consecutive reviewed authored merges with at most 1 finding per 100 changed lines.', metric: 'lowDefectRun', target: 10, tier: 'Gold', rewards: [] },
    { id: 'gh-clean-run', name: 'Clean Sweep', description: 'Have 3 consecutive authored PRs merged with verified clean reviews.', metric: 'bestCleanStreak', target: 3, tier: 'Silver', rewards: [] },
    { id: 'gh-consistency', name: 'Steady Engineer', description: 'Have authored contributions merged in 12 consecutive UTC weeks.', metric: 'bestStreakWeeks', target: 12, tier: 'Platinum', rewards: [] },
    { id: 'gh-review-streak', name: 'Reliable Teammate', description: 'Review other developers’ PRs in 4 consecutive UTC weeks.', metric: 'bestReviewStreakWeeks', target: 4, tier: 'Silver', rewards: [] },
    { id: 'gh-quality-growth', name: 'Always Improving', description: 'Earn Quality Improvement on two non-overlapping groups of reviewed merges.', metric: 'improvements', target: 2, tier: 'Gold', rewards: [] },
    { id: 'gh-cross-repo', name: 'Bridge Builder', description: 'Contribute meaningful merges or reviews across 3 repositories.', metric: 'repositories', target: 3, tier: 'Silver', rewards: [] },
    { id: 'gh-rounded', name: 'Well Rounded', description: 'Close 25 tickets, have 10 authored PRs merged, and review 10 other developers’ PRs.', metric: 'rounded', target: 1, tier: 'Gold', rewards: [] },
    ...[1, 25, 100, 250].map((target, i) => ({ id: `gh-merged-by-${target}`, name: `Release Steward ${['I', 'II', 'III', 'IV'][i]}`, description: `Personally merge ${target} meaningful human-authored PRs with verified merger attribution.`, metric: 'mergedBy', target, tier: ['Bronze', 'Silver', 'Gold', 'Platinum'][i], rewards: [] })),
    ...[10, 50, 100].map((target, i) => ({ id: `gh-tests-${target}`, name: `Test Builder ${['I', 'II', 'III'][i]}`, description: `Have ${target} meaningful authored PRs merged with complete test-file evidence.`, metric: 'tests', target, tier: ['Bronze', 'Silver', 'Gold'][i], rewards: [] })),
    ...[5, 25, 50].map((target, i) => ({ id: `gh-docs-${target}`, name: `Documentation Ally ${['I', 'II', 'III'][i]}`, description: `Have ${target} meaningful authored PRs merged with complete documentation-file evidence.`, metric: 'documentation', target, tier: ['Bronze', 'Silver', 'Gold'][i], rewards: [] })),
].map((a) => ({ ...a, category: a.metric === 'rounded' ? 'overall' : 'github' }));

function weekStreak(values, now) {
    const keys = new Set(values.map(utcWeek));
    let longest = 0;
    for (const key of keys) {
        if (keys.has(utcDay(dateMs(key) - 7 * DAY))) continue;
        let n = 0;
        for (let d = dateMs(key); keys.has(utcDay(d)); d += 7 * DAY) n++;
        longest = Math.max(longest, n);
    }
    let current = 0;
    let cursor = dateMs(utcWeek(now));
    if (!keys.has(utcDay(cursor))) cursor -= 7 * DAY;
    while (keys.has(utcDay(cursor))) { current++; cursor -= 7 * DAY; }
    return { longest, current };
}

/** Review signals are conservative proxies, never a claim that code is defect-free. */
export function inspectPR(pr, login, cfg = ECONOMY.github) {
    const authored = loginIs(pr.author, login) && human(pr.author, pr.authorType);
    const lines = Number(pr.additions) + Number(pr.deletions);
    const meaningful = Number.isFinite(lines) && lines >= cfg.minLines && Number(pr.changedFiles) > 0 && !pr.draft;
    const cutoff = pr.mergedAt ? dateMs(pr.mergedAt) : Infinity;
    const beforeMerge = (r) => validDate(r.submittedAt || r.createdAt) && dateMs(r.submittedAt || r.createdAt) <= cutoff;
    const reviews = (pr.reviews || []).filter((r) => beforeMerge(r) && !loginIs(r.author, pr.author));
    const humans = reviews.filter((r) => human(r.author, r.authorType));
    const comments = (pr.comments || []).filter(beforeMerge);
    const external = comments.filter((c) => !loginIs(c.author, pr.author));
    const actionable = external.filter((c) => human(c.author, c.authorType) ? actionText(c.body) : botFinding(c.body));
    const ambiguous = external.filter((c) => human(c.author, c.authorType) && !actionText(c.body) && !informational(c.body));
    const botAmbiguous = external.filter((c) => !human(c.author, c.authorType) && !botFinding(c.body) && !informational(c.body));
    const reviewFindings = reviews.filter((r) => human(r.author, r.authorType) ? actionText(r.body) && r.state !== 'CHANGES_REQUESTED' : botFinding(r.body));
    const ambiguousReviews = humans.filter((r) => r.state === 'COMMENTED' && String(r.body || '').trim() && !informational(r.body) && !actionText(r.body));
    const ambiguousBotReviews = reviews.filter((r) => !human(r.author, r.authorType) && !botFinding(r.body) && /actionable|potential issue|changes requested|\b(?:critical|major|minor)\b/i.test(r.body || '') && !/actionable comments posted:\s*0\b/i.test(r.body || ''));
    const changes = humans.filter((r) => r.state === 'CHANGES_REQUESTED');
    // Count issue threads once; a review summary/decision is only a fallback signal.
    const threadKeys = new Set(actionable.map((c) => String(c.inReplyToId || c.id)));
    const botThreadKeys = new Set(actionable.filter((c) => !human(c.author, c.authorType)).map((c) => String(c.inReplyToId || c.id)));
    const fallbackFindings = [...reviewFindings, ...changes].filter((r) => !actionable.some((c) => String(c.reviewId) === String(r.id)));
    const findings = threadKeys.size + new Set(fallbackFindings.map((r) => String(r.id))).size;
    const automated = botThreadKeys.size + new Set(fallbackFindings.filter((r) => !human(r.author, r.authorType)).map((r) => String(r.id))).size;
    const latest = new Map();
    for (const review of [...humans].sort((a, b) => dateMs(a.submittedAt) - dateMs(b.submittedAt))) {
        if (review.state !== 'COMMENTED') latest.set(String(review.author).toLowerCase(), review);
    }
    const decisions = [...latest.values()];
    const approved = Boolean(pr.headCommitId && decisions.some((r) => r.state === 'APPROVED' && r.commitId === pr.headCommitId)) && !decisions.some((r) => r.state === 'CHANGES_REQUESTED');
    const sampled = Boolean(pr.qualityComplete && pr.headCommitId && decisions.some((r) => r.commitId === pr.headCommitId && ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state)));
    const clean = sampled && approved && !changes.length && !actionable.length && !reviewFindings.length && !ambiguous.length && !botAmbiguous.length && !ambiguousReviews.length && !ambiguousBotReviews.length;
    const ownReviews = (pr.reviews || []).filter((r) => !authored && !loginIs(pr.author, login) && loginIs(r.author, login) && human(r.author, r.authorType) && validDate(r.submittedAt) && ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(r.state));
    const ownComments = (pr.comments || []).filter((c) => loginIs(c.author, login) && human(c.author, c.authorType) && c.path && validDate(c.createdAt) && actionText(c.body));
    const meaningfulReviews = ownReviews.filter((r) => ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state) || String(r.body || '').trim().length >= cfg.reviewBodyMinLength || ownComments.some((c) => String(c.reviewId) === String(r.id)));
    const review = meaningfulReviews.sort((a, b) => dateMs(a.submittedAt) - dateMs(b.submittedAt) || String(a.id).localeCompare(String(b.id)))[0];
    const constructiveDates = [
        ...ownComments.filter((c) => ownReviews.some((r) => String(r.id) === String(c.reviewId))).map((c) => c.createdAt),
        ...ownReviews.filter((r) => String(r.body || '').trim().length >= cfg.reviewBodyMinLength && actionText(r.body)).map((r) => r.submittedAt),
    ].sort((a, b) => dateMs(a) - dateMs(b));
    const constructive = Boolean(review && constructiveDates.length);
    const constructiveAt = constructiveDates[0];
    const acknowledgments = ownComments.flatMap((c) => (pr.comments || []).filter((reply) => String(reply.inReplyToId || '') === String(c.id) && loginIs(reply.author, pr.author) && validDate(reply.createdAt) && dateMs(reply.createdAt) >= dateMs(c.createdAt) && /\b(thanks|thank you|fixed|addressed|done|good catch|resolved)\b/i.test(reply.body || ''))).sort((a, b) => dateMs(a.createdAt) - dateMs(b.createdAt));
    const helpful = constructive && acknowledgments.length > 0;
    const helpfulAt = acknowledgments[0]?.createdAt;
    const paths = (pr.files || []).map((f) => f.path || '');
    const tests = paths.some((p) => /(^|\/)(tests?|__tests__)(\/|\.)|[.](test|spec)[.]|Tests?\.(cs|java)$/i.test(p));
    const documentation = paths.some((p) => /(^|\/)(docs?|readme)(\/|\.)|\.(md|rst)$/i.test(p));
    return { authored, meaningful, lines, clean, sampled, approved, findings, automated, iterations: new Set(changes.map((r) => r.commitId || r.id)).size, changes: changes.length > 0, review, constructive, constructiveAt, helpful, helpfulAt, tests, documentation, focused: meaningful && lines <= cfg.focusedMaxLines && pr.changedFiles <= cfg.focusedMaxFiles, complex: meaningful && lines >= cfg.complexMinLines && lines <= cfg.complexMaxLines && pr.changedFiles >= cfg.complexMinFiles && tests && pr.filesComplete };
}

/** Canonical event order makes caps independent of API page order and backfill order. */
export function contributionEvents(records, identity, cfg = ECONOMY.github, now = new Date()) {
    if (!identity?.login) return [];
    const events = [];
    for (const pr of Object.values(records || {})) {
        if (!pr.id || !pr.repo || !Number.isInteger(pr.number) || pr.number < 1 || !validDate(pr.createdAt)) continue;
        const q = inspectPR(pr, identity.login, cfg);
        const add = (kind, at, xp, group, extra = {}) => { if (validDate(at) && dateMs(at) <= now.getTime()) events.push({ id: `${pr.id}:${kind}`, prId: pr.id, repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, kind, at, rawXp: Math.max(0, Math.round(xp * (cfg.multiplier ?? 1))), group, ...extra }); };
        // Role evidence is distinct from authored contribution credit. Self-merges never pay twice.
        if (pr.state === 'merged' && q.meaningful && human(pr.author, pr.authorType)
            && loginIs(pr.mergedBy, identity.login) && pr.mergerComplete === true && pr.mergedByType === 'User' && human(pr.mergedBy, pr.mergedByType)) {
            add('mergedBy', pr.mergedAt, 0, 'role', { dataOnly: true, reviewedMerge: q.sampled && !q.authored });
        }
        if (q.authored && q.meaningful) {
            if (pr.bodyPresent) add('opened', pr.createdAt, cfg.opened, 'opened');
            if (pr.mergedAt && pr.state === 'merged') {
                add('merged', pr.mergedAt, cfg.merged, 'merged', { quality: q });
                if (q.focused) add('focused', pr.mergedAt, cfg.focused, 'bonus');
                if (q.complex) add('complex', pr.mergedAt, cfg.complex, 'bonus');
                if (q.clean) add('clean', pr.mergedAt, cfg.clean, 'bonus');
                if (q.clean && q.approved) add('firstPass', pr.mergedAt, cfg.firstPass, 'bonus');
                if (pr.bodyPresent && pr.filesComplete) add('readiness', pr.mergedAt, cfg.readiness, 'bonus');
                const hours = (dateMs(pr.mergedAt) - dateMs(pr.createdAt)) / 3600000;
                if (q.sampled && q.approved && q.lines >= cfg.turnaroundMinLines && hours >= cfg.turnaroundMinHours && hours <= (q.complex ? cfg.complexTurnaroundHours : cfg.turnaroundHours)) add('turnaround', pr.mergedAt, cfg.turnaround, 'bonus');
                if (q.documentation && pr.filesComplete) add('documentation', pr.mergedAt, cfg.documentation, 'bonus');
                if (q.tests && pr.filesComplete) add('tests', pr.mergedAt, cfg.tests, 'bonus');
            }
        }
        if (q.review && human(pr.author, pr.authorType)) {
            add('reviewed', q.review.submittedAt, cfg.reviewed, 'reviewed');
            if (q.constructive && pr.qualityComplete) add('constructive', q.constructiveAt, cfg.constructive, 'bonus');
            if (q.helpful && pr.qualityComplete) add('helpful', q.helpfulAt, cfg.helpful, 'bonus');
            const responseAt = String(q.review.body || '').trim().length >= cfg.reviewBodyMinLength ? q.review.submittedAt : q.constructiveAt;
            const elapsed = dateMs(responseAt) - dateMs(pr.createdAt);
            if (elapsed >= 0 && elapsed <= cfg.responsiveHours * 3600000) add('responsive', responseAt, cfg.responsive, 'bonus');
        }
    }
    events.sort((a, b) => dateMs(a.at) - dateMs(b.at) || a.id.localeCompare(b.id));
    const days = new Map();
    for (const event of events) {
        if (event.dataOnly) { event.xp = 0; continue; }
        const day = utcDay(event.at);
        const budget = days.get(day) || { total: 0 };
        event.xp = Math.max(0, Math.min(event.rawXp, cfg.dailyCaps[event.group] - (budget[event.group] || 0), cfg.dailyCaps.total - budget.total));
        budget[event.group] = (budget[event.group] || 0) + event.xp;
        budget.total += event.xp;
        days.set(day, budget);
    }
    return events;
}

function qualityGroups(merges) {
    const ordered = [...merges].sort((a, b) => dateMs(a.at) - dateMs(b.at));
    const rates = [];
    // Only non-overlapping groups of five merges with complete reviewed evidence qualify.
    for (let i = 0; i + 5 <= ordered.length; i += 5) {
        const group = ordered.slice(i, i + 5);
        if (!group.every((e) => e.quality.sampled)) { rates.push(null); continue; }
        const lines = group.reduce((sum, e) => sum + e.quality.lines, 0);
        rates.push({ rate: group.reduce((sum, e) => sum + e.quality.findings, 0) * 100 / Math.max(1, lines), at: group.at(-1).at });
    }
    const improvements = [];
    for (let i = 1; i < rates.length; i += 2) if (rates[i - 1]?.rate > 0 && rates[i] && rates[i].rate <= rates[i - 1].rate * .8) improvements.push(rates[i].at);
    return { improvements, current: rates.at(-1)?.rate ?? null, previous: rates.at(-2)?.rate ?? null };
}

export function githubChallenges(events, tickets = [], now = new Date()) {
    events = [...events].sort((a, b) => dateMs(a.at) - dateMs(b.at) || a.id.localeCompare(b.id));
    const merges = events.filter((e) => e.kind === 'merged');
    const reviews = events.filter((e) => e.kind === 'reviewed');
    const monthlyEvents = new Map();
    const monthlyTickets = new Map();
    for (const event of events) {
        const month = event.at.slice(0, 7);
        if (!monthlyEvents.has(month)) monthlyEvents.set(month, []);
        monthlyEvents.get(month).push(event);
    }
    for (const ticket of tickets) {
        if (!validDate(ticket.closedOn)) continue;
        const month = utcDay(ticket.closedOn).slice(0, 7);
        if (!monthlyTickets.has(month)) monthlyTickets.set(month, []);
        monthlyTickets.get(month).push(ticket);
    }
    const months = new Set([...monthlyEvents.keys(), ...monthlyTickets.keys()]);
    const mergeWeeks = new Map();
    for (const e of merges) {
        const week = utcWeek(e.at);
        if (!mergeWeeks.has(week)) mergeWeeks.set(week, []);
        mergeWeeks.get(week).push(e);
    }
    const currentWeek = mergeWeeks.get(utcWeek(now))?.length || 0;
    const currentDay = utcDay(now);
    const dailyReviews = reviews.filter((e) => utcDay(e.at) === currentDay).length;
    let run = 0, best = 0;
    for (const e of merges) { run = e.quality.clean ? run + 1 : 0; best = Math.max(best, run); }
    const quality = qualityGroups(merges);
    const release = events.filter((e) => e.kind === 'mergedBy' && e.reviewedMerge);
    const activity = events.filter((e) => ['merged', 'reviewed'].includes(e.kind));
    const counts = { daily: reviews.length, mergeWeek: Math.max(0, ...[...mergeWeeks.values()].map((week) => week.length)), quality: merges.filter((e) => e.quality.clean).length, reviews: reviews.length, constructive: events.filter((e) => e.kind === 'constructive').length, cleanStreak: best, consistency: weekStreak(merges.map((e) => e.at), now).longest, improvement: quality.improvements.length, balanced: 0, focused: events.filter((e) => e.kind === 'focused').length, team: 0,
        tests: events.filter((e) => e.kind === 'tests').length, documentation: events.filter((e) => e.kind === 'documentation').length, helpful: events.filter((e) => e.kind === 'helpful').length,
        release: release.length, reviewWeeks: weekStreak(reviews.map((e) => e.at), now).longest, repositories: new Set(activity.map((e) => e.repo)).size };
    const completions = [];
    const rows = GITHUB_CHALLENGES.map((c) => {
        const occurrences = [];
        const hit = (key, at) => occurrences.push({ id: `${c.id}:${key}`, kind: 'challenge', challengeId: c.id, category: 'github', at, xp: c.xp, treats: c.treats });
        if (c.rule === 'daily') {
            const days = new Set();
            for (const e of reviews) if (!days.has(utcDay(e.at))) { days.add(utcDay(e.at)); hit(utcDay(e.at), e.at); }
        } else if (c.rule === 'mergeWeek') {
            for (const [week, weekly] of mergeWeeks) if (weekly.length >= c.target) hit(week, weekly[c.target - 1].at);
        } else if (['balanced', 'team'].includes(c.rule)) {
            for (const month of months) {
                const monthly = monthlyEvents.get(month) || [];
                const monthTickets = monthlyTickets.get(month) || [];
                const ticketXp = monthTickets.reduce((sum, e) => sum + Number(e.xp || 0), 0);
                const value = c.rule === 'balanced' ? Math.min(ticketXp, monthly.reduce((sum, e) => sum + e.xp, 0)) : Math.min(monthly.filter((e) => e.kind === 'merged').length, monthly.filter((e) => e.kind === 'reviewed').length);
                if (month === currentDay.slice(0, 7)) counts[c.rule] = value;
                if (value >= c.target) {
                    const combined = [...monthly, ...monthTickets.map((t) => ({ at: t.closedOn, kind: 'ticket', xp: Number(t.xp || 0) }))].sort((a, b) => dateMs(a.at) - dateMs(b.at) || String(a.id || '').localeCompare(String(b.id || '')));
                    const totals = { ticket: 0, github: 0, merged: 0, reviewed: 0 };
                    const reached = combined.find((e) => {
                        if (e.kind === 'ticket') totals.ticket += e.xp;
                        else totals.github += e.xp;
                        if (['merged', 'reviewed'].includes(e.kind)) totals[e.kind]++;
                        return c.rule === 'balanced' ? Math.min(totals.ticket, totals.github) >= c.target : Math.min(totals.merged, totals.reviewed) >= c.target;
                    });
                    hit(month, reached.at);
                }
            }
        } else if (counts[c.rule] >= c.target) {
            const evidence = c.rule === 'release' ? release : c.rule === 'repositories' ? activity : c.rule === 'reviewWeeks' || c.rule === 'reviews' ? reviews : ['tests', 'documentation', 'helpful', 'constructive', 'focused'].includes(c.rule) ? events.filter((e) => e.kind === c.rule) : c.rule === 'quality' ? merges.filter((e) => e.quality.clean) : merges;
            let reachedAt = evidence[Math.min(c.target - 1, evidence.length - 1)]?.at || now.toISOString();
            if (c.rule === 'cleanStreak') {
                let consecutive = 0;
                reachedAt = merges.find((e) => { consecutive = e.quality.clean ? consecutive + 1 : 0; return consecutive >= c.target; }).at;
            }
            if (['consistency', 'reviewWeeks'].includes(c.rule)) {
                const weeks = new Set();
                reachedAt = evidence.find((e) => {
                    weeks.add(utcWeek(e.at));
                    let consecutive = 0;
                    for (let d = dateMs(utcWeek(e.at)); weeks.has(utcDay(d)); d -= 7 * DAY) consecutive++;
                    return consecutive >= c.target;
                }).at;
            }
            if (c.rule === 'repositories') {
                const repositories = new Set();
                reachedAt = evidence.find((e) => { repositories.add(e.repo); return repositories.size >= c.target; }).at;
            }
            hit('once', c.rule === 'improvement' ? quality.improvements[0] : reachedAt);
        }
        completions.push(...occurrences);
        const progress = c.rule === 'daily' ? dailyReviews : c.rule === 'mergeWeek' ? currentWeek : counts[c.rule];
        return { ...c, progress: Math.min(c.target, progress), count: occurrences.length, xpEarned: occurrences.length * c.xp };
    });
    return { rows, completions, bestCleanStreak: best, improvements: quality.improvements.length };
}

export function githubAnalytics(events, records, identity, bonuses = [], range = 'all', now = new Date()) {
    const end = now.getTime();
    const start = range === 'all' ? 0 : end - Number(range) * DAY;
    const inRange = (e) => dateMs(e.at) >= start && dateMs(e.at) <= end;
    const selected = events.filter(inRange);
    const rewards = bonuses.filter(inRange);
    const merges = selected.filter((e) => e.kind === 'merged');
    const reviews = selected.filter((e) => e.kind === 'reviewed');
    const samples = merges.filter((e) => e.quality.sampled);
    const clean = samples.filter((e) => e.quality.clean).length;
    const lines = samples.reduce((sum, e) => sum + e.quality.lines, 0);
    const baseXp = selected.reduce((sum, e) => sum + e.xp, 0);
    const bonusXp = rewards.reduce((sum, e) => sum + e.xp, 0);
    const breakdown = {};
    const timeline = new Map();
    for (const e of [...selected, ...rewards]) {
        breakdown[e.kind] = (breakdown[e.kind] || 0) + e.xp;
        const day = utcDay(e.at);
        const bucket = timeline.get(day) || { date: day, xp: 0, baseXp: 0, bonusXp: 0, opened: 0, merged: 0, authoredMerged: 0, mergedBy: 0, reviewed: 0, clean: 0, qualitySample: 0, findings: 0, lines: 0 };
        bucket.xp += e.xp;
        bucket[e.kind === 'challenge' ? 'bonusXp' : 'baseXp'] += e.xp;
        if (['opened', 'merged', 'mergedBy', 'reviewed'].includes(e.kind)) bucket[e.kind]++;
        if (e.kind === 'merged') bucket.authoredMerged++;
        if (e.kind === 'merged' && e.quality.sampled) { bucket.qualitySample++; bucket.clean += Number(e.quality.clean); bucket.findings += e.quality.findings; bucket.lines += e.quality.lines; }
        timeline.set(day, bucket);
    }
    const time = [...timeline.values()].sort((a, b) => a.date.localeCompare(b.date));
    const activity = selected.filter((e) => ['merged', 'reviewed'].includes(e.kind));
    const streak = weekStreak(merges.map((e) => e.at), now);
    const reviewStreak = weekStreak(reviews.map((e) => e.at), now);
    let lowRun = 0, lowDefectRun = 0;
    for (const e of merges) { lowRun = e.quality.sampled && e.quality.findings * 100 / Math.max(1, e.quality.lines) <= 1 ? lowRun + 1 : 0; lowDefectRun = Math.max(lowDefectRun, lowRun); }
    const closed = Object.values(records || {}).filter((p) => loginIs(p.author, identity?.login) && ['closed', 'merged'].includes(p.state) && validDate(p.closedAt || p.mergedAt) && inRange({ at: p.closedAt || p.mergedAt }));
    const mergedClosed = closed.filter((p) => p.state === 'merged' && p.mergedAt).length;
    const xpBetween = (from, to) => [...events, ...bonuses].filter((e) => dateMs(e.at) >= from && dateMs(e.at) < to).reduce((s, e) => s + e.xp, 0);
    const weekStart = dateMs(utcWeek(now));
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const priorMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    const weeks = new Map();
    for (const e of merges) weeks.set(utcWeek(e.at), (weeks.get(utcWeek(e.at)) || 0) + 1);
    const quality = qualityGroups(merges);
    const challenge = githubChallenges(selected, [], now);
    const unknownMerger = Object.values(records || {}).filter((pr) => pr.state === 'merged' && inRange({ at: pr.mergedAt })
        && human(pr.author, pr.authorType) && !pr.draft && Number(pr.changedFiles) > 0
        && Number(pr.additions) + Number(pr.deletions) >= ECONOMY.github.minLines
        && (pr.mergerComplete !== true || !pr.mergedBy || !pr.mergedByType)).length;
    return { xp: baseXp + bonusXp, baseXp, bonusXp, opened: selected.filter((e) => e.kind === 'opened').length, merged: merges.length, authoredMerged: merges.length, mergedBy: selected.filter((e) => e.kind === 'mergedBy').length, unknownMerger, reviewed: reviews.length, helpful: selected.filter((e) => e.kind === 'helpful').length, clean, qualitySample: samples.length, unknownQuality: merges.length - samples.length, cleanRate: samples.length ? clean / samples.length : null, mergeRate: closed.length ? mergedClosed / closed.length : null, averageSize: merges.length ? merges.reduce((s, e) => s + e.quality.lines, 0) / merges.length : null, findingsPerPr: samples.length ? samples.reduce((s, e) => s + e.quality.findings, 0) / samples.length : null, automatedFindingsPer100Lines: samples.length && lines ? samples.reduce((s, e) => s + e.quality.automated, 0) * 100 / lines : null, reviewIterations: samples.length ? samples.reduce((s, e) => s + e.quality.iterations, 0) / samples.length : null, changesRequestedRate: samples.length ? samples.filter((e) => e.quality.changes).length / samples.length : null, repositories: new Set(activity.map((e) => e.repo)).size, streakWeeks: streak.current, bestStreakWeeks: streak.longest, bestReviewStreakWeeks: reviewStreak.longest, lowDefectRun, bestCleanStreak: challenge.bestCleanStreak, breakdown, timeline: time, comparisons: { week: { current: xpBetween(weekStart, end + 1), previous: xpBetween(weekStart - 7 * DAY, weekStart) }, month: { current: xpBetween(monthStart, end + 1), previous: xpBetween(priorMonth, monthStart) } }, records: { bestDayXp: Math.max(0, ...time.map((d) => d.xp)), bestWeekMerges: Math.max(0, ...weeks.values()) }, qualityTrend: { current: quality.current, previous: quality.previous, sample: samples.length }, focused: selected.filter((e) => e.kind === 'focused').length, tests: selected.filter((e) => e.kind === 'tests').length, documentation: selected.filter((e) => e.kind === 'documentation').length, improvements: quality.improvements.length };
}

export function githubScope(settings = {}) {
    const organizations = [...new Set((settings.organizations || []).map((value) => value.toLowerCase()))].sort();
    const repositories = [...new Set((settings.repositories || []).map((value) => value.toLowerCase()))].sort();
    return { organizations, repositories, selected: organizations.length > 0 || repositories.length > 0,
        fingerprint: JSON.stringify({ organizations, repositories }) };
}

export function githubRecordInScope(record, settings) {
    const { organizations, repositories } = githubScope(settings);
    const repo = String(record?.repo || '').toLowerCase();
    return repositories.includes(repo) || organizations.includes(repo.split('/')[0]);
}

export function githubScopedDerived(profile, tickets = [], now = new Date()) {
    const gh = profile.github;
    const scope = githubScope(gh.settings);
    // An empty selection pauses discovery, but does not hide retained history.
    const records = Object.values(gh.records || {}).filter((record) => !scope.selected || githubRecordInScope(record, scope));
    const events = contributionEvents(records, gh.identity, undefined, now);
    const challenges = githubChallenges(events, tickets || [], now);
    return { events, challenges, analytics: {}, scopeFingerprint: scope.fingerprint };
}

export function githubView(profile, tickets, now = new Date(), derived = null) {
    const gh = profile.github;
    const scope = githubScope(gh.settings);
    const records = Object.values(gh.records || {}).filter((record) => !scope.selected || githubRecordInScope(record, scope));
    if ((scope.selected || derived?.scopeFingerprint) && derived?.scopeFingerprint !== scope.fingerprint) derived = githubScopedDerived(profile, tickets, now);
    let discovering = false;
    try { discovering = Boolean(JSON.parse(gh.cursor || 'null')?.search?.length); } catch { /* Legacy cursors have no discovery count. */ }
    const processed = records.filter((record) => record.qualityComplete && record.filesComplete).length;
    const unavailable = records.filter((record) => record.detailFailure?.terminal && !(record.qualityComplete && record.filesComplete)).length;
    const coverage = { discovered: records.length, processed, pending: records.length - processed - unavailable, unavailable, discovering,
        unknownMerger: records.filter((record) => record.state === 'merged' && (!record.mergerComplete || !record.mergedBy)).length };
    const events = derived?.events ?? contributionEvents(records, gh.identity, undefined, now);
    const challenges = derived?.challenges ?? githubChallenges(events, tickets || [], now);
    const analytics = derived?.analytics ?? {};
    for (const range of ['7', '30', '90', 'all']) analytics[range] ??= githubAnalytics(events, records, gh.identity, challenges.completions, range, now);
    return {
        events, challenges, coverage, identity: gh.identity, lastSync: gh.lastSync, lastAttempt: gh.lastAttempt, settings: gh.settings,
        analytics, summary: analytics.all, recent: [...events].reverse().slice(0, 12).map(({ quality, ...e }) => e),
        limitations: [
            'Authored merges (also named merged for compatibility) count meaningful authored PRs merged by anyone, not just self-merges.',
            'Personally merged counts require verified merger identity on meaningful human-authored PRs. These zero-XP role events never add quality samples or duplicate self-merge XP.',
            'Missing merger attribution is unknown, not inferred from authorship; personally merged is a known lower bound until explicit Sync backfills available evidence.',
            'Quality uses complete review snapshots with explicit human decisions; no review does not mean clean.',
            'Findings are conservative text/suggestion proxies, not a defect count. Ambiguous inline feedback blocks clean bonuses.',
            'Helpful feedback requires an explicit PR-author reply; current thread state cannot reconstruct historical resolution.',
            'Review iterations count distinct changes-requested review commits, not unobserved correction cycles.',
            'UTC periods and per-PR rewards/caps limit farming. No XP for ordinary comments, self-reviews or bot reviews.',
            'Readiness means a non-empty description and complete file context, not a semantic quality assessment.',
            'Repository access and deleted/private history may limit coverage.',
        ],
        economy: ECONOMY,
    };
}
