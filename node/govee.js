// govee.js — shared decode logic for Govee H5075 BLE advertisements
'use strict';

const GOVEE_COMPANY_ID = 0xEC88; // 60552

// md = full manufacturer-data Buffer as handed over by noble,
// INCLUDING the 2-byte company id at the front (little-endian: 0x88 0xEC).
// Everything is shifted +2 vs the bleak layout (see SPEC §2).
function decodeH5075(md) {
  if (!md || md.length < 7) return null;
  if (md.readUInt16LE(0) !== GOVEE_COMPANY_ID) return null;

  let temphum = (md[3] << 16) | (md[4] << 8) | md[5];
  const isNegative = (temphum & 0x800000) !== 0;
  temphum &= ~0x800000;

  const hum10 = temphum % 1000;
  const humidity = hum10 / 10;
  let tempC = (temphum - hum10) / 10000;
  if (isNegative) tempC = -tempC;

  const battery = md[6];
  const tempF = tempC * 9 / 5 + 32;
  return { tempC, tempF, humidity, battery };
}

module.exports = { GOVEE_COMPANY_ID, decodeH5075 };
