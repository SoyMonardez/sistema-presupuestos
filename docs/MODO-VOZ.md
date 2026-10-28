# Modo conversación por voz

El objetivo era una conversación como la del modo voz de ChatGPT, pero para cargar un presupuesto: hablarle de corrido y que vaya haciendo las cosas mientras tanto.

## Las piezas

| Pieza | Archivo | Modelo | Qué hace |
|---|---|---|---|
| Oído | `public/js/escucha.js`, `pcm-worklet.js` | ElevenLabs Scribe (en vivo) o Groq Whisper (respaldo) | Captura el micrófono y lo pasa a texto |
| Cortador | `server/lib/cortador.js`, `routes/voz.js` | Groq, modelo rápido | Separa lo dictado en pedidos completos y deja esperando lo que quedó a medias |
| Pensador | `routes/voz.js` | Claude | Decide los cambios: items, precios, encabezado, deshacer |
| Voz | `server/ai/elevenlabs.js`, `public/js/hablar.js` | ElevenLabs Flash | Contesta en voz alta, frase por frase |
| Orquestador | `public/js/conversacion.js` | — | Cola de pedidos, pendientes, modo Auto, cuándo hablar |
| Interfaz | `public/js/orbe.js` | — | Orbe en canvas, tarjetas, subtítulos, orbe flotante |

## Captura del micrófono

Un **AudioWorklet** corre en el hilo de audio, baja la señal del micrófono (44,1 o 48 kHz, en float) a **PCM de 16 bits a 16 kHz**, que es lo que pide Scribe, y manda bloques de 100 ms con el volumen medido. No traba la pantalla aunque haya animaciones.

- **En vivo:** los bloques van por WebSocket a ElevenLabs Scribe con un token de un solo uso que da el servidor. Llegan palabras parciales (para el subtítulo) y pedazos cerrados en cada pausa.
- **Respaldo:** si Scribe no está disponible, el propio navegador corta los pedazos por silencio, los arma como WAV y los manda a Whisper.

## El cortador

Lo dictado llega partido donde hubo una pausa, no donde termina la idea. *"Agregá demolición… uno, metro cuadrado… a 320 mil"* puede llegar en tres pedazos, y *"poné el título Casa Pérez y agregá un contrapiso"* son dos pedidos en uno.

- Las respuestas cortas que se repiten ("sí", "no", "deshacé", "terminamos") se resuelven con una **regex, sin modelo**: no vale la pena una vuelta de red por un "dale".
- El resto lo separa un modelo rápido de Groq (~100–250 ms).
- Una **regla fija** corrige al modelo: si un pedido termina en una palabra que pide continuación ("a", "de", "con", "el precio es"), vuelve a quedar esperando. El modelo daba por completo "…18 metros cuadrados a" y el precio llegaba como otro item.
- Si pasan 2 segundos sin hablar, lo que quedó esperando se manda igual.

## El pensador

Claude recibe los pedidos, los items actuales, el encabezado, la conversación reciente y el historial de cambios, y devuelve, en este orden:

```json
{ "pensamiento": "...", "ops": [...], "encabezado": {...}, "respuesta": "..." }
```

El orden importa porque la respuesta llega por **streaming**:
1. El **pensamiento** se muestra en una tarjeta mientras se escribe, antes de que se aplique nada.
2. Apenas aparece la clave `"respuesta"`, todo lo anterior ya está completo: el servidor valida las operaciones y las manda a la pantalla, que las aplica mientras Claude todavía redacta lo que va a decir.
3. La **respuesta** se dice en voz alta.

Reglas que se le dan y que salieron de usarlo:
- Cargar siempre, aunque falten datos: un nombre suelto ya es un item. Antes preguntaba "¿cuántos metros?" en cada uno y no cargaba ninguno.
- No inventar precios: si el trabajo no está en el tarifario queda en $0, salvo que se pida estimar. Como el modelo a veces estimaba igual, el servidor lo fuerza (`quitarEstimados`).
- No explicar el coeficiente de costos hablando: en voz es un párrafo que nadie quiere escuchar.

## Cuándo habla

- **No habla encima.** Mientras él sigue dictando, las respuestas se acumulan y cada cambio aplicado suena con un "tic". Cuando hace una pausa de ~1,2 s dice **un solo resumen**: *"Cargué 5 items. Dos quedaron sin precio. ¿Seguimos?"*. Es lo que permite leerle una planilla entera.
- **Acuse rápido.** Si pensar tarda más de 1,3 s y él ya se calló, contesta algo corto mientras tanto.
- **Eco.** Si lo que escuchó coincide con lo que el asistente acaba de decir, se descarta. Se comparan pares de palabras seguidas y no palabras sueltas, porque un pedido nuevo comparte palabras con la respuesta anterior ("el contrapiso quedó a 18 mil" → "ahora el contrapiso a 21 mil") y con palabras sueltas se descartaba.

## Precisión de la voz a texto

- **Vocabulario:** a Scribe (como *keyterms*) y a Whisper (como *prompt*) se les pasan los nombres del tarifario, los items del presupuesto abierto y vocabulario de obra. Es lo que más baja los errores con términos como "mampostería" o "H17".
- **Alucinaciones de Whisper:** sobre ruido o silencio, Whisper inventa frases de los subtítulos con los que se entrenó. Se piden los segmentos con su confianza y se descartan los que el propio Whisper marca como "probablemente no es voz". También se descartan frases típicas: probado con dos segundos de ruido, devolvía "¡Gracias!" las tres veces.
- **Pedazos sin voz:** no se manda nada con menos de 400 ms de voz real (golpes, toses).

## El altavoz del celular

Con el micrófono abierto, Android y iPhone ponen el audio en **modo llamada**: sale bajito por el parlante de la oreja. Ninguno deja que una página web fuerce el altavoz mientras se captura audio.

La solución: en pantallas táctiles, el micrófono **se suelta mientras el asistente habla** y se vuelve a abrir cuando termina (en ~60–200 ms). Un "tic" avisa que ya escucha. En Safari además se pide `navigator.audioSession.type = 'playback'` mientras habla. Para interrumpirlo, se toca el orbe. En la PC no hace falta y sigue escuchando siempre.

**Volumen:** un `<audio>` no pasa del volumen máximo. La voz pasa por un compresor, una ganancia y un limitador con techo. Medido con respuestas reales: entre 7 y 11,5 dB más fuerte sin recortar ninguna muestra.

## La interfaz

- **Orbe en canvas:** se deforma con el volumen. Cada fase tiene su color y su movimiento, para reconocerla aunque no se mire el color: escucha (celeste, respira), piensa (violeta, gira), carga (naranja, late), habla (verde agua, ondas). El borde de toda la pantalla brilla con el color de la fase.
- **Tarjetas** "Pienso hacer esto" con Aplicar / Dejalo cuando no está en Auto.
- **Orbe flotante:** el panel se achica deslizando la manija o con un botón. En el celular queda abajo al medio y en la PC abajo a la derecha. Se arrastra y recuerda dónde quedó.
- **Animaciones en la lista:** el item nuevo entra brillando, el nombre se escribe solo y el precio sube contando.
- **Sonidos** generados con Web Audio, sin archivos: entrar, salir, "te escucho", aplicado, error.

## Modo manual y deshacer

Sin Auto, cada tanda de cambios queda pendiente hasta un "sí". Los turnos nuevos se piensan sobre la lista **proyectada** (lo actual más lo pendiente), así "cambiale el precio al último" apunta al item que todavía espera confirmación. Si se rechaza una tanda, las siguientes pierden las operaciones que dependían de ella por número y conservan las altas.

Deshacer tiene dos niveles: una foto en memoria antes de cada tanda (instantáneo) y el **historial persistente** del servidor, que funciona aunque se haya recargado la página.
