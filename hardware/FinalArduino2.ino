// NeuroSky (HC-05) + L298N — Atenção controla PWM entre 55..80 (sem rampa).
// Mantém atencaoSuave (decai quando perde sinal), mas NÃO imprime no Serial.
// Piscadas: 3 em ≤2s => BOOST (dobro do MAX_PWM) por 0,5s.
// Checkpoint: a cada 20s envia "checkpoint" e zera até relaxamento >= 70, depois "checkpoint_end".

#include <SoftwareSerial.h>

// ====== Bluetooth (HC-05) ======
#define BT_RX 11
#define BT_TX 10
SoftwareSerial BT(BT_RX, BT_TX);

#define BAUD_BT   57600
#define BAUD_USB  115200
#define SYNC      0xAA

// ====== Ponte H (L298N) ======
const int ENA = 9;   // PWM (remover jumper ENB para usar PWM aqui)
const int IN1 = 3;   // direção
const int IN2 = 4;   // direção

// ====== Limites de velocidade (PWM) ======
const int MIN_PWM = 50;
const int MAX_PWM = 80;

// ====== Boost por piscadas ======
const unsigned long BLINK_GAP_MS = 2000;   // ≤ 2s entre piscadas
const unsigned long BOOST_MS      = 500;   // 0,5s
const int BOOST_PWM = (int)min((long)(MAX_PWM * 1.2L), 255L);  // dobro do máximo (80->160)

int  blinkCount           = 0;
unsigned long lastBlinkMs = 0;
bool boostAtivo           = false;
unsigned long boostFimMs  = 0;

// ====== Detector de blink por RAW ======
const int   THRESHOLD   = 600;   // |raw - baseline|
const int   REFRACT_MS  = 250;   // período refratário
const int   BASE_WIN    = 64;    // janela média móvel p/ baseline
const int   MIN_PEAK_MS = 15;    // duração mínima acima do limiar
const int   BLINK_MIN   = 160;   // força mínima aceita (0..255)
const int   BLINK_MAX   = 200;   // força máxima aceita

long lastBlinkRawMs = -10000;
int  baseBuf[BASE_WIN];
int  baseIdx = 0;
long baseSum = 0;
bool baseFilled = false;
int  aboveCount = 0;

// ====== Parser ======
uint8_t payload[169];
uint8_t plength=0, pindex=0, csum=0, csumRx=0;
enum S { SYNC1, SYNC2, LEN, DATA, CHK }; S st = SYNC1;

// ====== Métricas ======
int sinal        = -1;   // 0=ótimo; 200=sem contato
int atencao      = -1;   // 0..100
int relaxamento  = -1;   // 0..100
int atencaoSuave = 0;    // 0..100 (decai quando sem sinal)

// ====== Temporização / link ======
unsigned long lastByteMs    = 0;  // qualquer byte recebido
unsigned long lastSignalMs  = 0;  // última tag 0x02 (POOR_SIGNAL)
unsigned long lastDecayMs   = 0;  // <<< global para o decaimento
bool linkAtivo() { return (millis() - lastByteMs) < 1500; }

// ====== Checkpoint ======
const unsigned long CHECKPOINT_INTERVAL_MS = 20000UL; // a cada 20s
const int RELAX_OK = 70;                               // sair quando relax >= 70
unsigned long lastCheckpointMs = 0;
bool checkpointAtivo = false;

// ---------- Utilidades ----------
void resetParser() { st = SYNC1; plength=0; pindex=0; csum=0; }

int updateBaseline(int sample) {
  if (!baseFilled && baseIdx < BASE_WIN) {
    baseBuf[baseIdx++] = sample; baseSum += sample;
    if (baseIdx == BASE_WIN) baseFilled = true;
  } else if (baseFilled) {
    baseSum -= baseBuf[baseIdx];
    baseBuf[baseIdx] = sample;
    baseSum += sample;
    baseIdx = (baseIdx + 1) % BASE_WIN;
  }
  int n = baseFilled ? BASE_WIN : (baseIdx > 0 ? baseIdx : 1);
  return baseSum / n;
}

// ====== Blink comum (chamado por 0x16 e por RAW) ======
void onValidBlink(int strength) {
  if (strength < BLINK_MIN || strength > BLINK_MAX) return;

  Serial.print(F("{\"evento\":\"blink\",\"forca\":"));
  Serial.print(strength);
  Serial.println(F("}"));

  unsigned long now = millis();
  if (blinkCount == 0) blinkCount = 1;
  else blinkCount = (now - lastBlinkMs <= BLINK_GAP_MS) ? (blinkCount + 1) : 1;
  lastBlinkMs = now;

  if (blinkCount >= 3) {
    blinkCount = 0;
    boostAtivo = true;
    boostFimMs = now + BOOST_MS;
    Serial.println(F("{\"evento\":\"boost\"}"));
  }
}

// ====== Detector baseado em RAW ======
void processRawSample(int raw) {
  static int baseline = 0;
  baseline = updateBaseline(raw);
  int diff  = raw - baseline;
  int adiff = (diff >= 0) ? diff : -diff;

  if (adiff >= THRESHOLD) aboveCount++;
  else aboveCount = 0;

  if (aboveCount > 0) {
    long dt = millis() - lastBlinkRawMs;
    if (dt > REFRACT_MS && aboveCount * 2 >= MIN_PEAK_MS) {
      lastBlinkRawMs = millis();
      int strength = adiff / 4; if (strength > 255) strength = 255;
      onValidBlink(strength);
      aboveCount = 0;
    }
  }
}

// ====== Decaimento da ATENÇÃO quando sem sinal ======
#define DECAY_PER_SEC 20
#define DECAY_TICK_MS 100
void updateAttentionDecay() {
  unsigned long now = millis();
  if (atencaoSuave < 0) atencaoSuave = max(0, atencao);

  // Sem sinal = (sinal >= 200) OU link caiu
  bool semSinal = (sinal >= 200) || !linkAtivo();

  if (semSinal) {
    unsigned long elapsed = now - lastDecayMs;
    if (elapsed >= DECAY_TICK_MS) {
      int dec = (int)((DECAY_PER_SEC * elapsed) / 1000);
      if (dec < 1) dec = 1;
      atencaoSuave = max(0, atencaoSuave - dec);
      lastDecayMs = now;
    }
  } else {
    // Com sinal bom: segue a atenção crua
    if (atencao >= 0) atencaoSuave = atencao;
    lastDecayMs = now;
  }
}

// ====== Parser ThinkGear ======
void processPayload(uint8_t* buf, uint8_t len) {
  for (uint8_t i = 0; i < len; ) {
    uint8_t code = buf[i++];
    if (code == 0x55) continue; // EXCODE

    if (code == 0x02 || code == 0x04 || code == 0x05 || code == 0x16) {
      if (i >= len) break;
      uint8_t val = buf[i++];
      if (code == 0x02) { sinal = val; lastSignalMs = millis(); }
      else if (code == 0x04) { atencao = val; }
      else if (code == 0x05) { relaxamento = val; }
      else if (code == 0x16) { onValidBlink(val); } // BLINK_STRENGTH
    } else {
      if (i >= len) break;
      uint8_t vlen = buf[i++];
      if (i + vlen > len) break;

      // RAW: 0x80, len=0x02 => [hi][lo]
      if (code == 0x80 && vlen == 0x02 && (i + 1) < len) {
        int hi  = (int8_t)buf[i++];
        int lo  = buf[i++] & 0xFF;
        int raw = (hi << 8) | lo; // 16-bit signed
        processRawSample(raw);
      } else {
        i += vlen; // ignora blocos longos (ex.: 0x83)
      }
    }
  }
}

// ====== APLICA PWM (SEM RAMPA) ======
void aplicarPWM(int pwmOut) {
  pwmOut = constrain(pwmOut, 0, 255);
  analogWrite(ENB, pwmOut);             // direção já setada no setup()
}

void setup() {
  // Ponte H
  pinMode(ENB, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  digitalWrite(IN3, HIGH);   // frente (troque HIGH/LOW se inverter)
  digitalWrite(IN4, LOW);
  analogWrite(ENB, 0);

  // Seriais
  Serial.begin(BAUD_USB);
  BT.begin(BAUD_BT);

  lastCheckpointMs = millis();
  lastDecayMs = millis();

  Serial.println(F("{\"status\":\"iniciando\",\"bt\":57600,\"usb\":115200}"));
}

void loop() {
  // --- Recepção BT / Parser ---
  while (BT.available()) {
    uint8_t b = BT.read();
    lastByteMs = millis();

    switch (st) {
      case SYNC1: if (b == SYNC) st = SYNC2; break;
      case SYNC2: st = (b == SYNC) ? LEN : SYNC1; break;
      case LEN:
        plength = b;
        if (plength == 0 || plength > sizeof(payload)) resetParser();
        else { pindex=0; csum=0; st=DATA; }
        break;
      case DATA:
        payload[pindex++] = b; csum += b;
        if (pindex >= plength) st = CHK;
        break;
      case CHK:
        csumRx = b; csum = 0xFF - csum;
        if (csum == csumRx) processPayload(payload, plength);
        resetParser();
        break;
    }
  }

  // Fallback: se faz >2s sem 0x02 ou o link caiu, considere sem contato
  if ((millis() - lastSignalMs) > 2000 || !linkAtivo()) {
    sinal = 200;
  }

  // Mantém decaimento MESMO sem pacotes
  updateAttentionDecay();

  // ---------- BOOST: encerra quando expirar ----------
  if (boostAtivo && millis() >= boostFimMs) boostAtivo = false;

  // ---------- CHECKPOINT: a cada 20s, para até relax >= 70 ----------
  unsigned long now = millis();
  if (!checkpointAtivo && (now - lastCheckpointMs >= CHECKPOINT_INTERVAL_MS)) {
    checkpointAtivo = true;
    Serial.println(F("checkpoint"));
  }
  if (checkpointAtivo && relaxamento >= RELAX_OK) {
    checkpointAtivo = false;
    lastCheckpointMs = now;
    Serial.println(F("checkpoint_end"));
  }

  // ---------- Alvo de PWM ----------
  int targetPWM = 0;

  if (boostAtivo) {
    targetPWM = BOOST_PWM; // boost tem prioridade
  } else if (checkpointAtivo) {
    targetPWM = 0;         // parado até relaxamento >= 70
  } else if (sinal < 200 && linkAtivo() && atencaoSuave > 0) {
    // 1..100 -> MIN..MAX usando atenção SUAVIZADA
    targetPWM = map(constrain(atencaoSuave, 1, 100), 1, 100, MIN_PWM, MAX_PWM);
  } else {
    // sem contato: atencaoSuave vai decaindo até 0
    targetPWM = (atencaoSuave <= 0) ? 0 : map(atencaoSuave, 1, 100, MIN_PWM, MAX_PWM);
  }

  aplicarPWM(targetPWM);

  // ---------- Debug enxuto (NÃO imprime atencaoSuave) ----------
  static unsigned long lastDbg=0;
  if (now - lastDbg >= 500) {
    lastDbg = now;
    int attLog = checkpointAtivo ? 0 : atencao; // mostra 0 durante checkpoint
    Serial.print(F("{\"link\":"));       Serial.print(linkAtivo()?"true":"false");
    Serial.print(F(",\"sinal\":"));      Serial.print(sinal);
    Serial.print(F(",\"att\":"));        Serial.print(attLog);
    Serial.print(F(",\"relax\":"));      Serial.print(relaxamento);
    Serial.print(F(",\"checkpoint\":")); Serial.print(checkpointAtivo ? 1 : 0);
    Serial.print(F(",\"boost\":"));      Serial.print(boostAtivo ? 1 : 0);
    Serial.print(F(",\"pwm\":"));        Serial.print(targetPWM);
    Serial.println(F("}"));
  }
}