# Slow Planner — Dormant Phase-Switching Logic Disabled

## What was found

Discovered while gathering accurate material for the documentation
update. Slow Planner had a fully-designed dynamic phase-switching
decision (30-min trend hysteresis, 3.7 kW / 4.5 kW bounds — carried over
from an even earlier "simple" version of PV Eco, predating everything
built in this thread) that updated `pv.car_phases` in flow context —
but never actually commanded the go-e. No HTTP request, no
`rest_command`, nothing: confirmed via full-file grep for any actuation.

`pv.car_phases` is read by both Power Assembler (`carDrawEstimate`) and
Fast Tracker (`idealAmp`) purely for amp **math** — both trust it
unconditionally. If surplus had ever sustained above 4.5 kW for 30
minutes, this logic would have flipped its belief to 3-phase while the
physical charger stayed on whatever it actually was — the amp math
would then target roughly 3× too little current, invisible without
manually cross-checking the go-e itself against flow context.

This is independent of and predates the strategy-transition phase
switch built earlier in this thread (`ev_strategy.py`, fixed 1-phase for
pv_eco / 3-phase for fast on strategy/boost transitions) — two separate
mechanisms that both believed they owned phase state, never talking to
each other.

## Fix

Disabled explicitly rather than left dormant: `phases` is now pinned to
`1`, matching the only phase mode PV Eco actually runs at today under
the transition-based switch. This makes the assembler/tracker's amp
math trustworthy by construction — there's only one reality to track
while this is off, so it can't silently diverge from it.

## Verification

Extracted and executed the phase block in isolation: confirmed `phases`
stays `1` even across 10 simulated cycles of sustained target power well
above the old 4.5 kW trip threshold (which would have flipped the old
logic inside 3 cycles), and confirmed the dead trend-counter state is no
longer written at all.

## Documented as a future option

To revive dynamic mid-session switching later: the trend logic would
need to actually call `rest_command.goe_set_psm` (same mechanism as the
transition switch) and be reconciled with it so the two can't
independently disagree about phase state. This will be captured in
`docs/PV_ECO_FLOW.md` as a known future option, not a currently-working
feature.

## File

`slow_planner.js` — supersedes the production copy for this one block;
everything else in the file is unchanged from what's currently deployed.
