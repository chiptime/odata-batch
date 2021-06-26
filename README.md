# odata-batch

This module formats both the request and response of batch operations. It supports **OData v2** but it may also support **OData V3**.

## Install

`npm install odata-batch --save`

## Example
You only need to generate an array with the requests you want to send, the requests will be returned in the same order as in the array.

    const { ODataBatch } = require('odata-batch')

    const calls = [
        {
            "method": "POST",
            "url": "https://****",
            "data": {
                "__metadata": {
                    "uri": "Candidate('202')"
                },
                "name": "Bruno"
            }
        },
        {
            "method": "GET",
            "url": "https://****"
        },
        {
            "method": "GET",
            "url": "https://****"
        }
    ];

    const config = {
        url: `https://*****/$batch`,
        auth: '******', // base64 string for basic     auth
        calls,
    };

    var batchOperation = new ODataBatch(config);

    batchOperation.send()
        .then(async function (a) {
            console.log(a);
        })
        .catch(function (e) {
            console.error(e);
        });


## Extends

By default, axios is used as the HTTP connection library, but you can create your own adapter for your preferred HTTP library.

You need a class with a method send that will recieve necesary data for create the request and a class for format the batch response. Need as second param an object with data and headers.
In method send of your class, you will recieve the next params:
+ url: url of your system
+ batchRequest: raw response from odata
+ config: an object with headers that we will use for batch request, add more configs if you need.
+ accept: is the response type in each individual batch subquery, is necessary for format correctly individual responses.
+ BatchParser: class that will parse the response.

Additionally, to respect the typescript typing, we use a `createBatchResponse` function to create the class, export it from the module.

`ODataBatchAxiosRepository.ts`


    import axios, { AxiosRequestConfig } from 'axios';
    import {
        ODataBatchRepository,
        createBatchResponse,
        BatchResponseConstructor
        } from "odata-batch";

    export class ODataBatchAxiosRepository implements     ODataBatchRepository {
        async send(
            url: string,
            batchRequest: string,
            config: AxiosRequestConfig | undefined,
            accept: string,
            BatchParser: BatchResponseConstructor
        ): Promise<any> {

            const request = await axios.post(url,     batchRequest, config);

            console.log('from custom adapter');

            return createBatchResponse(BatchParser,     request, accept).response;
        }
    }


Based in:
+ [batchcall](https://www.npmjs.com/package/batchcall)
+ [batch-odata](https://www.npmjs.com/package/batch-odata)