const axios = require('axios');

async function test() {
  try {
    const res = await axios.post('http://localhost:3000/api/tv-shows', {
      title: 'Test TV Show with Trailer',
      description: 'Test description',
      bannerImage: 'https://example.com/banner.jpg',
      trailerUrl: 'https://example.com/trailer.mp4',
      status: 'draft'
    });
    console.log('SUCCESS! Created TV Show with ID:', res.data.data._id);
    console.log('Banner Image saved as:', res.data.data.bannerImage);
    console.log('Trailer URL saved as:', res.data.data.trailerUrl);
  } catch (err) {
    console.error('Error:', err.response ? err.response.data : err.message);
  }
}

test();
