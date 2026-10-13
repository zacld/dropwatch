import { skiddle } from './skiddle.js';
import { fatsoma } from './fatsoma.js';
import { dice } from './dice.js';
import { ticketmaster } from './ticketmaster.js';
import { residentAdvisor } from './resident-advisor.js';

// Registered in implementation priority order.
export const CONNECTORS = [skiddle, fatsoma, dice, ticketmaster, residentAdvisor];
export const connectorById = id => CONNECTORS.find(c => c.id === id) ?? null;
