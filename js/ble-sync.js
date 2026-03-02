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
    const tdsRaw = Number(raw?.tds_raw ?? raw?.tdsRaw ?? raw?.tds ?? raw?.TDS ?? raw?.tdsValue ?? raw?.salinity);
    const tdsComp = Number(raw?.tds_comp ?? raw?.tdsComp ?? raw?.tds_corrected ?? raw?.tdsCorrected ?? raw?.tds ?? raw?.TDS ?? raw?.tdsValue ?? raw?.salinity);
    const moisture = Number(raw?.moisture ?? raw?.humidity ?? raw?.nem ?? raw?.soil);
    const temp = Number(raw?.temp ?? raw?.temperature ?? raw?.sicaklik);
    const time = Number(raw?.time ?? raw?.device_time);
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
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error('Cihaz verisi JSON formatında değil');
    }
    if (Array.isArray(parsed?.data)) {
      for (let i = parsed.data.length - 1; i >= 0; i -= 1) {
        const row = normalizeReading(parsed.data[i]);
        if (row && (Number.isFinite(row.tdsRaw) || Number.isFinite(row.tdsComp) || Number.isFinite(row.temp))) {
          return row;
        }
      }
      throw new Error('data[] içinde geçerli kayıt yok');
    }
    return normalizeReading(parsed);
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
      soil: Number.isFinite(row?.moisture) ? row.moisture : null,
      salinity: Number.isFinite(row?.tds) ? row.tds : null,
      temp: Number.isFinite(row?.temp) ? row.temp : null,
      time: Number.isFinite(row?.time) ? row.time : null,
      tds_raw: Number.isFinite(row?.tdsRaw) ? row.tdsRaw : null,
      tds_comp: Number.isFinite(row?.tdsComp) ? row.tdsComp : null,
      timestamp: row?.timestamp || new Date().toISOString(),
      moisture: Number.isFinite(row?.moisture) ? row.moisture : null,
      tds: Number.isFinite(row?.tds) ? row.tds : null
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
      try {
        res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...state.config.headers },
          body: JSON.stringify(row)
        });
      } catch (err) {
        emit(onStatus, 'Sunucuya erisilemiyor (network/CORS)');
        throw err;
      }

      if (!res.ok) {
        throw new Error(`Sunucuya gönderim başarısız: ${res.status}`);
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
      const reading = await readDevice(onStatus);
      enqueue(reading);
      try {
        await flushQueue(onStatus);
        emit(onStatus, '✅ Gönderildi!');
      } catch (err) {
        // BLE okuma başarılıysa veriyi localde tut ve sync'i düşürme.
        emit(onStatus, 'BLE okundu, gönderim beklemede');
      }
      return reading;
    },

    getLocal() {
      return readLocal();
    }
  };

  global.BLESync = BLESync;
})(window);
