'use strict';

// Small timezone helpers built on Intl so the app needs no date library.
// Everything stored is UTC ISO; only display and slot planning are zoned.

function zoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// How far the zone is ahead of UTC at this exact instant, in milliseconds.
function offsetMs(date, timeZone) {
  const p = zoneParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

// "2026-08-30" + "09:00" in Europe/London -> the correct UTC Date.
// Runs the offset lookup twice so clock-change days land on the right instant.
function zonedToUtc(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(naive - offsetMs(new Date(naive), timeZone));
  guess = new Date(naive - offsetMs(guess, timeZone));
  return guess;
}

// Local calendar date (YYYY-MM-DD) for an instant.
function localDate(date, timeZone) {
  const p = zoneParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function localTime(date, timeZone) {
  const p = zoneParts(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// The next `count` local calendar dates starting today.
function upcomingDates(from, timeZone, count) {
  const dates = [];
  for (let i = 0; i < count; i += 1) {
    dates.push(localDate(new Date(from.getTime() + i * 86400000), timeZone));
  }
  return dates;
}

function isValidSlot(slot) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(slot);
}

module.exports = { zoneParts, offsetMs, zonedToUtc, localDate, localTime, upcomingDates, isValidSlot };
