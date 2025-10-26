////////////////////////////////////////////////////////////////////////
// Arduino Bluetooth Interface with Mindwave
// (inclui saída de relaxamento em JSON por linha)
////////////////////////////////////////////////////////////////////////

#include <SoftwareSerial.h>
SoftwareSerial BT(4, 2); // Rx/Tx (ajuste se necessário)

#define LED 13
#define BAUDRATE 57600
#define DEBUGOUTPUT 0

// checksum variables
byte  generatedChecksum = 0;
byte  checksum = 0; 
int   payloadLength = 0;
byte  payloadData[64] = {0};
byte  poorQuality = 0;
byte  attention = 0;
byte  meditation = 0;

// system variables
long    lastReceivedPacket = 0;
boolean bigPacket = false;

void setup() {
  pinMode(LED, OUTPUT);
  BT.begin(BAUDRATE);       // SoftwareSerial (ex.: ATmega328P)
  Serial.begin(BAUDRATE);   // USB
}

byte ReadOneByte() {
  int ByteRead;
  while (!BT.available());
  ByteRead = BT.read();

  #if DEBUGOUTPUT
    Serial.print((char)ByteRead);
  #endif
  return ByteRead;
}

void loop() {
  // Procurar bytes de sincronismo 0xAA 0xAA
  if (ReadOneByte() == 170) {
    if (ReadOneByte() == 170) {

      payloadLength = ReadOneByte();
      if (payloadLength > 169) return; // inválido

      generatedChecksum = 0;
      for (int i = 0; i < payloadLength; i++) {
        payloadData[i] = ReadOneByte();
        generatedChecksum += payloadData[i];
      }

      checksum = ReadOneByte();
      generatedChecksum = 255 - generatedChecksum;

      if (checksum == generatedChecksum) {

        // Valores padrão a cada pacote
        poorQuality = 200;
        attention   = 0;
        meditation  = 0;
        bigPacket   = false;

        // Parse do payload
        for (int i = 0; i < payloadLength; i++) {
          switch (payloadData[i]) {
            case 0x02: // POOR_SIGNAL
              i++;
              poorQuality = payloadData[i];
              bigPacket = true;
              break;

            case 0x04: // ATTENTION
              i++;
              attention = payloadData[i];
              break;

            case 0x05: // MEDITATION (relaxamento)
              i++;
              meditation = payloadData[i];
              break;

            case 0x80: // Raw wave (ignorar tamanho 2 + dado)
              i = i + 3;
              break;

            case 0x83: // EEG power (ignorar 24 bytes + tamanho)
              i = i + 25;
              break;

            default:
              break;
          }
        }

        #if !DEBUGOUTPUT
          if (bigPacket) {
            // LED indica boa qualidade de sinal
            if (poorQuality == 0) digitalWrite(LED, HIGH);
            else                  digitalWrite(LED, LOW);

            // Saída JSON por linha (fácil de parsear)
            Serial.print("{\"sinal\":");
            Serial.print((int)poorQuality);
            Serial.print(",\"atencao\":");
            Serial.print((int)attention);
            Serial.print(",\"relaxamento\":");
            Serial.print((int)meditation);
            Serial.println("}");
          }
        #endif

      } else {
        // Erro de checksum - ignorar
      }
    }
  }
}