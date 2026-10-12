// wf.channel.telegram > "Card message": the card image (binary) with its caption and button; a card the Media
// service could not draw is left out (the answer with the list was sent already).
const cards = $('Photo cards').all();
return $input.all().map((it, i) => ({ it, card: cards[i] }))
  .filter(({ it }) => it.binary && it.binary.data && /^image\//.test(it.binary.data.mimeType || ''))
  .map(({ it, card }) => ({ json: card.json, binary: { data: { ...it.binary.data, fileName: 'card.jpg' } } }));
