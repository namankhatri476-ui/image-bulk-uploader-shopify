import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const skusString = formData.get("skus");
  const statusFilter = formData.get("statusFilter") || "ALL";
  
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
                    status
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
            const product = edges[0].node;
            if (statusFilter === "ALL" || product.status === statusFilter) {
              results[sku] = { id: product.id, status: product.status };
            } else {
              results[sku] = { error: "status_mismatch", actualStatus: product.status };
            }
          } else {
            results[sku] = { error: "not_found" };
          }
        } catch (error) {
          console.error(`Error resolving SKU ${sku}:`, error);
          results[sku] = { error: "server_error" };
        }
      })
    );
  }

  return Response.json({ results });
};
