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
- Otra regla fija: si el último pedido nombra un trabajo pero **todavía no trae ningún número** ("limpieza periódica y final"), espera. Leyendo una planilla, el nombre llega antes que "global, uno, 650 mil"; mandado solo, el item quedaba en $0 y los datos llegaban sueltos en el pedido siguiente, donde un precio terminó en otro item (los cordones). No esperan las preguntas ni los "sacá…".
- Si pasan 2,5 segundos sin hablar, lo que quedó esperando se manda igual.

## De qué item habla

Con los datos sueltos es fácil que el que piensa los ponga en el item equivocado, y por voz él no se entera: dicta mirando el papel. Hay dos capas:

- **El prompt** le explica de quién son los datos sueltos (del trabajo que se nombró justo antes) y cuándo preguntar antes de hacer: datos que no sabe a qué item van, una frase cortada, dos lecturas que cambian la plata ("¿650 o 650 mil?").
- **El servidor** (`server/lib/referencias.js`) no deja cambiar ni borrar un item existente si nada lo ata a lo que dijo: su nombre (o una palabra del nombre), su número, "el último" o "todos". Lo último que se habló cuenta solo si el turno no trae items nuevos: "ponele 650 mil" justo después de cargar la limpieza va a la limpieza. Si se frena algo, no se aplica y en vez de lo que el modelo iba a decir pregunta: *"No me quedó claro a qué item iba eso: no toqué «Cordones». ¿A cuál se lo pongo?"*.

## Abreviaturas

Dictado, todo llega con las palabras enteras. En el título y la dirección se escriben como en un presupuesto: Av., Bv., B°, Pje., N°, Dpto., Mza., Gral., Dr., Ing., Arq. Lo pide el prompt y lo asegura `server/lib/abreviaturas.js`. Si él pide la palabra completa, se respeta.

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

- **No habla encima.** Mientras él sigue dictando, las respuestas se acumulan y cada cambio aplicado suena con un "tic". Cuando hace una pausa de ~1,8 s (antes 1,2: arrancaba a hablar mientras él respiraba entre fila y fila) dice **un solo resumen**: *"Cargué 5 items. Dos quedaron sin precio. ¿Seguimos?"*. Es lo que permite leerle una planilla entera.
- **Acuse rápido.** Si pensar tarda más de 1,3 s y él ya se calló, contesta algo corto mientras tanto.
- **Eco.** Si lo que escuchó coincide con lo que el asistente acaba de decir, se descarta. Se comparan pares de palabras seguidas y no palabras sueltas, porque un pedido nuevo comparte palabras con la respuesta anterior ("el contrapiso quedó a 18 mil" → "ahora el contrapiso a 21 mil") y con palabras sueltas se descartaba.

## Precisión de la voz a texto

- **Vocabulario:** a Scribe (como *keyterms*) y a Whisper (como *prompt*) se les pasan los nombres del tarifario, los items del presupuesto abierto y vocabulario de obra. Es lo que más baja los errores con términos como "mampostería" o "H17".
- **Alucinaciones de Whisper:** sobre ruido o silencio, Whisper inventa frases de los subtítulos con los que se entrenó. Se piden los segmentos con su confianza y se descartan los que el propio Whisper marca como "probablemente no es voz". También se descartan frases típicas: probado con dos segundos de ruido, devolvía "¡Gracias!" las tres veces.
- **Pedazos sin voz:** no se manda nada con menos de 400 ms de voz real (golpes, toses).

## Con ruido de fondo (gimnasio, obra, música)

Antes, "dejó de hablar" era que el volumen bajara de un umbral fijo. Con música de fondo nunca bajaba: el dictado no se mandaba y la conversación no pasaba a pensar hasta que paraba el ruido. Ahora hay cuatro capas:

1. **Filtro de voz (200–4000 Hz).** El volumen para decidir se mide solo en la banda de la voz (en `pcm-worklet.js` para la conversación y con dos `BiquadFilter` en `voice.js` para el dictado). El bombo de la música (~50 Hz) baja 24 dB y la voz queda igual. El audio que se transcribe no se filtra.
2. **Umbral que se acomoda al lugar** (`ruido-de-fondo.js`). Se toma el percentil 10 del volumen de los últimos 4 s como piso de ruido, y hay voz cuando el volumen pasa 2,5 veces ese piso. Un percentil bajo y no un promedio porque el promedio se lo come la voz misma si habla de corrido; entre palabra y palabra el volumen siempre baja al nivel del ruido. Los primeros 1,5 s no se le cree al piso, para que no aprenda de su propia voz si arranca a hablar apenas toca. En silencio de verdad sigue mandando el umbral fijo de siempre.
3. **Filtro de fondo de Scribe** (`filter_background_audio`). Si Scribe no lo acepta, se reconecta sin él.
4. **Red de seguridad por el texto.** Si el VAD igual no corta:
   - Conversación: si el texto en vivo de Scribe no cambia en 1,6 s, se le pide que cierre el pedazo (`commit: true`). Si Scribe se queja, no se le pide más.
   - Dictado: si dos transcripciones parciales seguidas (cada ~2,5 s) dan el mismo texto, se corta y se manda.

`voice.test.mjs` prueba el detector con escenas de gimnasio (música con bombo, voz que sube y baja entre sílabas) en 100 semillas cada una.

## El altavoz del celular

Con el micrófono abierto, Android y iPhone ponen el audio en **modo llamada**: sale bajito por el parlante de la oreja. Ninguno deja que una página web fuerce el altavoz mientras se captura audio.

La solución: en pantallas táctiles, el micrófono **se suelta mientras el asistente habla** y se vuelve a abrir cuando termina (en ~60–200 ms). Un "tic" avisa que ya escucha. En Safari además se pide `navigator.audioSession.type = 'playback'` mientras habla. Para interrumpirlo, se toca el orbe. En la PC no hace falta y sigue escuchando siempre.

**Volumen:** un `<audio>` no pasa del volumen máximo. La voz pasa por un compresor, una ganancia y un limitador con techo. Medido con respuestas reales: entre 7 y 11,5 dB más fuerte sin recortar ninguna muestra.

## La burbuja: flotando sobre otras apps

Para leer un pliego que está en WhatsApp mientras el presupuesto se carga solo. Una página web no puede dibujar encima de otras apps, pero sí puede mandar un video a "imagen en imagen": Android lo muestra en una ventanita arriba de todo, que se arrastra a cualquier parte de la pantalla y mantiene viva la página (el micrófono sigue abierto). `burbuja.js` pinta el orbe en un canvas, lo convierte en video con `captureStream()` y ese video es el que flota. Solo el orbe sobre negro (la ventanita no puede ser transparente): el color y el movimiento dicen en qué anda, y en pausa queda quieto.

- Se abre con el botón «Flotar para leer desde otra app», abajo del panel (solo aparece si el navegador lo permite). Tiene que ser con un toque **antes de salir**: el navegador no deja abrirla sola. Probándolo, salió de la app sin tocarlo esperando que apareciera como en ChatGPT; sin la burbuja Android frena la página y deja de escuchar. Por eso el botón tiene texto y, si sale sin tocarlo, al volver se le explica qué pasó. Donde Chrome abre la burbuja solo (`enterpictureinpicture`, por ahora en la PC), se aprovecha.
- La ventanita no se puede tocar como un botón. Android le pone sus controles: volver a la app, cerrar y reproducir/pausa, que acá es **pausar y seguir escuchando**.
- Con la burbuja abierta el micrófono **no se suelta** para hablar (ver "El altavoz del celular"): pedirlo de nuevo con la app atrás puede fallar y dejarlo sin escuchar. La respuesta sale más bajito, pero mientras lee un pliego casi no hace falta oírla.
- Se pinta con un intervalo y no con `requestAnimationFrame`, que se frena cuando la página no está a la vista.
- En iPhone no sirve: Safari corta el micrófono al salir a otra app.

## La interfaz

- **Orbe en canvas:** se deforma con el volumen. Cada fase tiene su color y su movimiento, para reconocerla aunque no se mire el color: escucha (celeste, respira), piensa (violeta, gira), carga (naranja, late), habla (verde agua, ondas). El borde de toda la pantalla brilla con el color de la fase.
- **Tarjetas** "Pienso hacer esto" con Aplicar / Dejalo cuando no está en Auto.
- **Orbe flotante:** el panel se achica deslizando la manija o con un botón. En el celular queda abajo al medio y en la PC abajo a la derecha. Se arrastra y recuerda dónde quedó.
- **Animaciones en la lista:** el item nuevo entra brillando, el nombre se escribe solo y el precio sube contando.
- **Sonidos** generados con Web Audio, sin archivos: entrar, salir, "te escucho", aplicado, error.

## Modo manual y deshacer

Sin Auto, cada tanda de cambios queda pendiente hasta un "sí". Los turnos nuevos se piensan sobre la lista **proyectada** (lo actual más lo pendiente), así "cambiale el precio al último" apunta al item que todavía espera confirmación. Si se rechaza una tanda, las siguientes pierden las operaciones que dependían de ella por número y conservan las altas.

Deshacer tiene dos niveles: una foto en memoria antes de cada tanda (instantáneo) y el **historial persistente** del servidor, que funciona aunque se haya recargado la página.
