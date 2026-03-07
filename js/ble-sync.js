(function (global) {
  const LOCAL_KEY = global.BLE_SYNC_LOCAL_KEY || 'hydrosense-ble-segments';
  const DEFAULTS = {
    apiUrl: '',
    headers: {},
    deviceName: 'TarlaSensor',
    serviceUuid: '12345678-1234-1234-1234-123456789abc',
    characteristicUuid: '87654321-4321-4321-4321-cba987654321'
  };

  const state = {
    config: { ...DEFAULTS },
    device: null,
    characteristic: null,
    initialized: false
  };

  function emit(onStatus, message) {
    if (typeof onStatus === 'function') onStatus(message);
  }

  function readLocal() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocal(list) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  }

  function enqueue(reading) {
    const queue = readLocal();
    queue.push(reading);
    writeLocal(queue);
    return queue;
  }

  function parseNumeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const normalized = value.trim().replace(',', '.');
      if (!normalized) return null;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function toIsoTimestampFromNumericTime(value) {
    if (!Number.isFinite(value)) return null;
    let unixMs = null;
    if (value > 1e12) unixMs = value;
    else if (value > 1e9) unixMs = value * 1000;
    if (!unixMs) return null;
    const d = new Date(unixMs);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function normalizeReading(raw) {
    const tdsRaw = parseNumeric(raw?.tds_raw ?? raw?.tdsRaw ?? raw?.tds ?? raw?.TDS ?? raw?.tdsValue ?? raw?.salinity ?? raw?.salt);
    const tdsComp = parseNumeric(raw?.tds_comp ?? raw?.tdsComp ?? raw?.tds_corrected ?? raw?.tdsCorrected ?? raw?.tds ?? raw?.TDS ?? raw?.tdsValue ?? raw?.salinity ?? raw?.salt);
    const moisture = parseNumeric(raw?.moisture ?? raw?.humidity ?? raw?.nem ?? raw?.soil);
    const temp = parseNumeric(raw?.temp ?? raw?.temperature ?? raw?.sicaklik);
    const time = parseNumeric(raw?.time ?? raw?.device_time);
    const timestamp = raw?.timestamp || raw?.syncedAt || toIsoTimestampFromNumericTime(time) || new Date().toISOString();
    const tds = Number.isFinite(tdsComp) ? tdsComp : (Number.isFinite(tdsRaw) ? tdsRaw : null);

    return {
      tds,
      tdsRaw: Number.isFinite(tdsRaw) ? tdsRaw : null,
      tdsComp: Number.isFinite(tdsComp) ? tdsComp : null,
      moisture: Number.isFinite(moisture) ? moisture : null,
      temp: Number.isFinite(temp) ? temp : null,
      time: Number.isFinite(time) ? time : null,
      timestamp
    };
  }

  async function connect(onStatus) {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth desteklenmiyor');
    }

    // Stale characteristic'i kullanma: cihaz bağlı değilse sıfırla.
    if (state.characteristic && state.device?.gatt?.connected) {
      return state.characteristic;
    }
    state.characteristic = null;

    emit(onStatus, 'Bluetooth cihazı aranıyor...');
    state.device = await navigator.bluetooth.requestDevice({
      filters: [{ name: state.config.deviceName }],
      optionalServices: [state.config.serviceUuid]
    });

    emit(onStatus, 'Cihaza bağlanıyor...');
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService(state.config.serviceUuid);
    state.characteristic = await service.getCharacteristic(state.config.characteristicUuid);

    state.device.addEventListener('gattserverdisconnected', () => {
      state.characteristic = null;
    });

    return state.characteristic;
  }

  function parsePayload(text) {
    let parsed;
    const raw = String(text ?? '').trim();
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      const firstBracket = raw.indexOf('[');
      const lastBracket = raw.lastIndexOf(']');

      try {
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
        } else if (firstBracket !== -1 && lastBracket > firstBracket) {
          parsed = JSON.parse(raw.slice(firstBracket, lastBracket + 1));
        } else {
          throw new Error('JSON bulunamadi');
        }
      } catch (_e) {
        throw new Error('Cihaz verisi JSON formatında değil');
      }
    }
    if (Array.isArray(parsed?.data)) {
      const readings = [];
      for (let i = parsed.data.length - 1; i >= 0; i -= 1) {
        const row = normalizeReading(parsed.data[i]);
        if (row && (Number.isFinite(row.tdsRaw) || Number.isFinite(row.tdsComp) || Number.isFinite(row.temp))) {
          readings.push(row);
        }
      }
      if (readings.length) return readings.reverse();
      throw new Error('data[] içinde geçerli kayıt yok');
    }
    const single = normalizeReading(parsed);
    if (!single) throw new Error('Geçerli sensör kaydı yok');
    return [single];
  }

  async function readDevice(onStatus) {
    // Bazı cihazlarda ilk read sırasında "GATT Error: Unknown" dönebiliyor.
    // Bu durumda bir kez yeniden bağlanıp tekrar dener.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const characteristic = await connect(onStatus);
        emit(onStatus, 'Veri okunuyor...');
        const value = await characteristic.readValue();
        const text = new TextDecoder('utf-8').decode(value);
        return parsePayload(text);
      } catch (err) {
        const message = String(err?.message || err || '').toLowerCase();
        const isGattUnknown = message.includes('gatt') && message.includes('unknown');
        state.characteristic = null;
        if (state.device?.gatt?.connected) {
          try { state.device.gatt.disconnect(); } catch (_) {}
        }
        if (!isGattUnknown || attempt === 1) {
          throw err;
        }
        emit(onStatus, 'Bağlantı yenileniyor...');
      }
    }
  }

  async function flushQueue(onStatus) {
    const queue = readLocal();
    if (!queue.length) return { sent: 0, remaining: 0 };
    const payload = queue.map((row) => ({
      salt: Number.isFinite(row?.tdsComp) ? row.tdsComp : (Number.isFinite(row?.tdsRaw) ? row.tdsRaw : null),
      sicaklik: Number.isFinite(row?.temp) ? row.temp : null,
      sensor_id: row?.sensorId || row?.sensor_id || 'esp-t1'
    }));

    const apiUrl = state.config.apiUrl;
    if (!apiUrl || apiUrl === 'API_URL_BURAYA' || !navigator.onLine) {
      emit(onStatus, 'Offline: veri localde saklandı');
      return { sent: 0, remaining: queue.length };
    }

    emit(onStatus, 'Sunucuya gönderiliyor...');
    let sent = 0;
    for (const row of payload) {
      let res;
      let raw = '';
      try {
        res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...state.config.headers },
          body: JSON.stringify(row)
        });
        raw = await res.text();
      } catch (err) {
        emit(onStatus, 'Sunucuya erisilemiyor (network/CORS)');
        throw err;
      }

      if (!res.ok) {
        throw new Error(`Sunucuya gönderim başarısız: ${res.status} ${raw || ''}`.trim());
      }
      sent += 1;
    }

    writeLocal([]);
    return { sent, remaining: 0 };
  }

  const BLESync = {
    init(options = {}) {
      state.config = {
        ...DEFAULTS,
        ...state.config,
        ...options,
        headers: { ...DEFAULTS.headers, ...(global.BLE_SYNC_API_HEADERS || {}), ...(options.headers || {}) },
        deviceName: options.deviceName || global.BLE_SYNC_DEVICE_NAME || state.config.deviceName,
        serviceUuid: options.serviceUuid || global.BLE_SYNC_SERVICE_UUID || state.config.serviceUuid,
        characteristicUuid: options.characteristicUuid || global.BLE_SYNC_CHARACTERISTIC_UUID || state.config.characteristicUuid
      };

      if (!state.initialized) {
        state.initialized = true;
        window.addEventListener('online', () => {
          this.sync(() => {}).catch(() => {});
        });
      }

      this.sync(() => {}).catch(() => {});
    },

    async sync(onStatus) {
      const readings = await readDevice(onStatus);
      readings.forEach((reading) => enqueue(reading));
      let uploadError = null;
      try {
        await flushQueue(onStatus);
        emit(onStatus, '✅ Gönderildi!');
      } catch (err) {
        // BLE okuma başarılıysa veriyi localde tut ve sync'i düşürme.
        const msg = String(err?.message || err || 'gonderim beklemede');
        emit(onStatus, `BLE okundu, gonderim beklemede: ${msg}`);
        console.error('BLE upload failed:', err);
        uploadError = err;
      }
      return {
        reading: readings[readings.length - 1] || null,
        uploadError
      };
    },

    getLocal() {
      return readLocal();
    }
  };

  global.BLESync = BLESync;
})(window);
