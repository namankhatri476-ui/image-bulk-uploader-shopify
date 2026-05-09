import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const skusString = formData.get("skus");
  
  if (!skusString) {
    return Response.json({ error: "No SKUs provided" }, { status: 400 });
  }

  let skus;
  try {
    skus = JSON.parse(skusString);
  } catch (e) {
    return Response.json({ error: "Invalid SKUs format" }, { status: 400 });
  }

  const results = {};

  // Process in chunks to avoid overwhelming the API or hitting rate limits
  const chunkSize = 5;
  for (let i = 0; i < skus.length; i += chunkSize) {
    const chunk = skus.slice(i, i + chunkSize);
    
    await Promise.all(
      chunk.map(async (sku) => {
        try {
          const response = await admin.graphql(
            `#graphql
            query getProductBySku($query: String!) {
              products(first: 1, query: $query) {
                edges {
                  node {
                    id
                  }
                }
              }
            }`,
            {
              variables: {
                query: `sku:"${sku}"`,
              },
            }
          );
          
          const json = await response.json();
          const edges = json.data?.products?.edges;
          
          if (edges && edges.length > 0) {
            results[sku] = edges[0].node.id;
          } else {
            results[sku] = null;
          }
        } catch (error) {
          console.error(`Error resolving SKU ${sku}:`, error);
          results[sku] = null;
        }
      })
    );
  }

  return Response.json({ results });
};
